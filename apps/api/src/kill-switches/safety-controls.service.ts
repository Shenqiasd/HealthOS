import { createHash, randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import type { AdminPrincipal, AdminRole } from "../admin/admin-principal";
import { hasAdminRole } from "../admin/admin-principal";
import { DatabaseService } from "../database/prisma.service";
import type { SafetyControlActionDto } from "./dto/safety-control-action.dto";

type ControlView = {
  schema_version: 1;
  control_type: string;
  control_key: string;
  scope_type: string;
  scope_id: string;
  active: boolean;
  version: number;
  reason: string;
  updated_at: string;
};

function canonicalHash(input: SafetyControlActionDto): string {
  return createHash("sha256").update(JSON.stringify({
    control_type: input.control_type,
    control_key: input.control_key,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    active: input.active,
    expected_version: input.expected_version,
    reason: input.reason.trim(),
  })).digest("hex");
}

function correlationId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException("Valid correlation identifier is required");
  }
}

@Injectable()
export class SafetyControlsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(principal: AdminPrincipal): Promise<{ schema_version: 1; controls: ControlView[] }> {
    this.requireOperations(principal);
    const rows = await this.database.$queryRaw<Array<{
      control_type: string;
      control_key: string;
      scope_type: string;
      scope_id: string;
      active: boolean;
      version: number;
      reason: string;
      created_at: Date;
    }>>`
      SELECT DISTINCT ON ("control_type", "control_key", "scope_type", "scope_id")
        "control_type", "control_key", "scope_type", "scope_id", "active", "version", "reason", "created_at"
      FROM "safety_control_revisions"
      ORDER BY "control_type", "control_key", "scope_type", "scope_id", "version" DESC
      LIMIT 200
    `;
    return { schema_version: 1, controls: rows.map((row) => ({
      schema_version: 1,
      control_type: row.control_type,
      control_key: row.control_key,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      active: row.active,
      version: row.version,
      reason: row.reason,
      updated_at: row.created_at.toISOString(),
    })) };
  }

  async mutate(
    principal: AdminPrincipal,
    input: SafetyControlActionDto,
    requestCorrelationId: string,
  ): Promise<ControlView> {
    this.requireOperations(principal);
    correlationId(requestCorrelationId);
    const scope = await this.validateScope(input);
    const requestHash = canonicalHash(input);
    const role = this.auditRole(principal);
    try {
      return await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.control_type}:${input.control_key}:${input.scope_type}:${input.scope_id}`}, 0))`;
      const replay = await tx.safetyControlMutation.findUnique({
        where: { idempotencyKey: input.idempotency_key },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException("Idempotency key payload changed");
        return replay.resultJson as unknown as ControlView;
      }
      const previous = await tx.safetyControlRevision.findFirst({
        where: {
          controlType: input.control_type,
          controlKey: input.control_key,
          scopeType: input.scope_type,
          scopeId: input.scope_id,
        },
        orderBy: { version: "desc" },
      });
      const currentVersion = previous?.version ?? 0;
      if (currentVersion !== input.expected_version) throw new ConflictException("Safety control version is stale");
      const version = currentVersion + 1;
      const revisionId = randomUUID();
      const [snapshots] = await tx.$queryRaw<Array<{
        before_json: Prisma.JsonValue | null;
        after_json: Prisma.JsonValue;
        before_hash: string;
        after_hash: string;
      }>>`
        SELECT
          ${previous ? Prisma.sql`healthos_safety_control_snapshot(
            ${previous.controlType}, ${previous.controlKey}, ${previous.scopeType}, ${previous.scopeId},
            ${previous.active}, ${previous.version}::integer, ${previous.reason}
          )` : Prisma.sql`NULL::jsonb`} AS "before_json",
          healthos_safety_control_snapshot(
            ${input.control_type}, ${input.control_key}, ${input.scope_type}, ${input.scope_id},
            ${input.active}, ${version}::integer, ${input.reason.trim()}
          ) AS "after_json",
          encode(digest(coalesce(${previous ? Prisma.sql`healthos_safety_control_snapshot(
            ${previous.controlType}, ${previous.controlKey}, ${previous.scopeType}, ${previous.scopeId},
            ${previous.active}, ${previous.version}::integer, ${previous.reason}
          )` : Prisma.sql`NULL::jsonb`}, 'null'::jsonb)::text, 'sha256'), 'hex') AS "before_hash",
          encode(digest(healthos_safety_control_snapshot(
            ${input.control_type}, ${input.control_key}, ${input.scope_type}, ${input.scope_id},
            ${input.active}, ${version}::integer, ${input.reason.trim()}
          )::text, 'sha256'), 'hex') AS "after_hash"
      `;
      if (!snapshots) throw new ConflictException("Safety control audit hashing failed");
      const audit = await tx.auditLog.create({ data: {
        adminActorId: principal.actorId,
        actorRole: role,
        action: input.active ? "safety_control.activate" : "safety_control.deactivate",
        resourceType: "safety_control",
        resourceId: revisionId,
        reason: input.reason.trim(),
        correlationId: requestCorrelationId,
        beforeJson: snapshots.before_json === null ? Prisma.DbNull : snapshots.before_json as Prisma.InputJsonValue,
        afterJson: snapshots.after_json as Prisma.InputJsonValue,
        beforeHash: snapshots.before_hash,
        afterHash: snapshots.after_hash,
        operationVersion: version,
      } });
      await tx.$executeRaw`SELECT set_config('healthos.safety_control_audit_id', ${audit.id}, true)`;
      const revision = await tx.safetyControlRevision.create({ data: {
        id: revisionId,
        controlType: input.control_type,
        controlKey: input.control_key,
        scopeType: input.scope_type,
        scopeId: input.scope_id,
        subjectUserId: scope.subjectUserId,
        ruleBundleId: scope.ruleBundleId,
        active: input.active,
        version,
        reason: input.reason.trim(),
        adminActorId: principal.actorId,
        correlationId: requestCorrelationId,
      } });
      await tx.safetyControlAuditConsumption.create({ data: {
        auditId: audit.id,
        controlRevisionId: revision.id,
        operationVersion: version,
      } });
      await tx.safetyControlEpoch.update({
        where: { id: "global" },
        data: { version: { increment: 1 }, updatedAt: new Date() },
      });
      const result: ControlView = {
        schema_version: 1,
        control_type: revision.controlType,
        control_key: revision.controlKey,
        scope_type: revision.scopeType,
        scope_id: revision.scopeId,
        active: revision.active,
        version: revision.version,
        reason: revision.reason,
        updated_at: revision.createdAt.toISOString(),
      };
      await tx.safetyControlMutation.create({ data: {
        adminActorId: principal.actorId,
        subjectUserId: scope.subjectUserId,
        idempotencyKey: input.idempotency_key,
        requestHash,
        resultJson: result,
      } });
        return result;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2010" &&
        error.meta?.code === "40001"
      ) {
        throw new ConflictException("Safety control was changed concurrently");
      }
      throw error;
    }
  }

  private async validateScope(input: SafetyControlActionDto): Promise<{
    subjectUserId: string | null;
    ruleBundleId: string | null;
  }> {
    const killSwitchKeys = new Set([
      "global.proactive_messages", "channel.delivery", "llm.generation",
      "rule.bundle", "user.recommendations", "review.share",
    ]);
    const featureFlagKeys = new Set([
      "feature.daily_recommendations", "feature.weekly_review_share", "feature.channel_delivery",
      "feature.llm_generation",
    ]);
    if (
      (input.control_type === "kill_switch" && !killSwitchKeys.has(input.control_key)) ||
      (input.control_type === "feature_flag" && !featureFlagKeys.has(input.control_key))
    ) {
      throw new BadRequestException("Control key does not belong to control type");
    }
    const globalKeys = new Set([
      "global.proactive_messages", "llm.generation", "review.share",
      "feature.daily_recommendations", "feature.weekly_review_share", "feature.llm_generation",
    ]);
    const channelKeys = new Set(["channel.delivery", "feature.channel_delivery"]);
    if (globalKeys.has(input.control_key) && (input.scope_type !== "global" || input.scope_id !== "*")) {
      throw new BadRequestException("Control requires global scope");
    }
    if (channelKeys.has(input.control_key) && (input.scope_type !== "channel" || !["apns", "wecom"].includes(input.scope_id))) {
      throw new BadRequestException("Control requires a supported channel scope");
    }
    if (input.control_key === "user.recommendations") {
      if (input.scope_type !== "user" || !/^[0-9a-f-]{36}$/i.test(input.scope_id)) {
        throw new BadRequestException("Control requires user scope");
      }
      if (!await this.database.user.findUnique({ where: { id: input.scope_id }, select: { id: true } })) {
        throw new BadRequestException("Control user scope does not exist");
      }
      return { subjectUserId: input.scope_id, ruleBundleId: null };
    }
    if (input.control_key === "rule.bundle") {
      if (input.scope_type !== "rule_bundle" || !/^[0-9a-f-]{36}$/i.test(input.scope_id)) {
        throw new BadRequestException("Control requires rule-bundle scope");
      }
      if (!await this.database.ruleBundle.findUnique({ where: { id: input.scope_id }, select: { id: true } })) {
        throw new BadRequestException("Control rule-bundle scope does not exist");
      }
      return { subjectUserId: null, ruleBundleId: input.scope_id };
    }
    return { subjectUserId: null, ruleBundleId: null };
  }

  private requireOperations(principal: AdminPrincipal): void {
    if (!hasAdminRole(principal, ["operator", "admin"])) {
      throw new ForbiddenException("Operations authority is required");
    }
  }

  private auditRole(principal: AdminPrincipal): AdminRole {
    return hasAdminRole(principal, ["admin"]) ? "admin" : "operator";
  }
}
