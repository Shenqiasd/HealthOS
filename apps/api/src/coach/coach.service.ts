import { createHash } from "node:crypto";

import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import type { CoachProvider } from "../ai/coach-provider";
import type { DatabaseService } from "../database/prisma.service";
import type { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import type { ProfileCandidateService } from "../profile/profile-candidate.service";
import {
  CoachOrchestrator,
  type CoachAuthorizationMode,
  type CoachGateSnapshot,
  type CoachSendCommand,
} from "./coach-orchestrator";
import type { CoachEvidence } from "./coach-context";
import { PrismaCoachTurnStore } from "./prisma-coach-turn.store";

interface LockedCoachEvidenceRow {
  action_id: string;
  action_code: string | null;
  action_local_date: Date;
  action_snapshot_id: string;
  action_status: string;
  action_is_primary: boolean;
  snapshot_id: string;
  snapshot_hash: string | null;
  snapshot_action_code: string | null;
  snapshot_safety_class: string;
  snapshot_review_status: string;
  snapshot_created_at: Date;
  snapshot_run_id: string;
  snapshot_provenance: Prisma.JsonValue;
  publication_id: string;
  publication_snapshot_id: string;
  publication_action_id: string | null;
  run_id: string;
  run_user_id: string;
  run_consent_epoch: number;
  run_status: string;
  run_local_date: Date;
  run_profile_id: string;
  run_bundle_id: string;
  bundle_status: string;
  profile_id: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export class CoachService {
  private readonly turns: PrismaCoachTurnStore;
  private readonly orchestrator: CoachOrchestrator;

  constructor(
    private readonly database: DatabaseService,
    private readonly flags: FeatureFlagsService,
    provider: CoachProvider,
    candidates: ProfileCandidateService,
  ) {
    this.turns = new PrismaCoachTurnStore(database);
    this.orchestrator = new CoachOrchestrator({
      turns: this.turns,
      provider,
      authorize: (command, mode) => this.gate(command, mode),
      recheck: (command, mode) => this.gate(command, mode),
      loadEvidence: (command, gate) => this.evidence(command, gate),
      proposeLimitation: ({ userId, sourceText, idempotencyKey }) => candidates.propose(
        userId,
        {
          candidateType: "mobility_limitation",
          structuredValue: {
            code: /膝|knee/i.test(sourceText) ? "knee_discomfort" : "mobility_limitation",
            active: true,
          },
          sourceText,
          idempotencyKey,
        },
        this.turns.currentTransaction(),
      ),
    });
  }

  async createThread(userId: string, input: { clientThreadId: string; idempotencyKey: string }) {
    const requestHash = sha256({ client_thread_id: input.clientThreadId });
    return this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coach-thread-create:${userId}:${input.idempotencyKey}`}, 0))`;
      await this.requireHealthAuthorization(tx, userId, "user_privacy");
      const replay = await tx.coachThread.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException("Coach thread idempotency key payload changed");
        return this.threadView(replay);
      }
      const collision = await tx.coachThread.findUnique({
        where: { userId_clientThreadId: { userId, clientThreadId: input.clientThreadId } },
      });
      if (collision) throw new ConflictException("Coach client thread identity already exists");
      return this.threadView(await tx.coachThread.create({ data: {
        userId,
        clientThreadId: input.clientThreadId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      } }));
    }, { isolationLevel: "ReadCommitted" });
  }

  send(command: CoachSendCommand) {
    return this.orchestrator.send(command);
  }

  async listMessages(userId: string, threadId: string) {
    return this.database.$transaction(async (tx) => {
      await this.requireHealthAuthorization(tx, userId, "none");
      const thread = await tx.coachThread.findUnique({ where: { id: threadId } });
      if (!thread) throw new NotFoundException("Coach thread not found");
      if (thread.userId !== userId) throw new ForbiddenException("Coach thread is not owned by the current user");
      const messages = await tx.coachMessage.findMany({ where: { threadId }, orderBy: { sequence: "asc" } });
      return {
        thread: this.threadView(thread),
        messages: messages.map((message) => ({
          id: message.id,
          sequence: message.sequence,
          role: message.role,
          intent: message.intent,
          content: message.content,
          sources: message.sourcesJson,
          safety_class: message.safetyClass,
          action_code: message.actionCode,
          fixed_response_code: message.fixedResponseCode,
          needs_human_review: message.needsHumanReview,
          created_at: message.createdAt.toISOString(),
        })),
      };
    });
  }

  private async gate(command: CoachSendCommand, mode: CoachAuthorizationMode): Promise<CoachGateSnapshot> {
    const tx = this.turns.currentTransaction();
    const llm = mode === "provider"
      ? await this.flags.evaluateLlmGeneration(tx, true)
      : {
          feature: { version: 0, enabled: false, control_epoch: "not_required" },
          kill_switch: { version: 0, enabled: false, control_epoch: "not_required" },
        };
    const authorization = await this.requireHealthAuthorization(
      tx,
      command.userId,
      mode === "limitation" ? "privacy" : "user_privacy",
    );
    await tx.$queryRaw`SELECT "id" FROM "coach_threads" WHERE "id" = ${command.threadId}::uuid FOR SHARE`;
    const thread = await tx.coachThread.findUnique({ where: { id: command.threadId } });
    if (!thread) throw new NotFoundException("Coach thread not found");
    if (thread.userId !== command.userId) throw new ForbiddenException("Coach thread is not owned by the current user");
    return {
      userId: command.userId,
      threadId: thread.id,
      summaryVersion: thread.summaryVersion,
      consentEpoch: authorization.consentEpoch,
      featureVersion: llm.feature.version,
      featureEnabled: llm.feature.enabled,
      killSwitchVersion: llm.kill_switch.version,
      killSwitchActive: llm.kill_switch.enabled,
      controlEpoch: llm.feature.control_epoch,
      localDate: authorization.localDate,
    };
  }

  private async requireHealthAuthorization(
    tx: Prisma.TransactionClient,
    userId: string,
    lock: "none" | "privacy" | "user_privacy",
  ): Promise<{ consentEpoch: number; localDate: string }> {
    if (lock === "user_privacy") {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR SHARE`;
    }
    if (lock !== "none") {
      await tx.$queryRaw`SELECT "id" FROM "privacy_reconciliation" WHERE "id" = 'global' FOR SHARE`;
    }
    const [user, privacy, consent] = await Promise.all([
      tx.user.findUnique({ where: { id: userId } }),
      tx.privacyReconciliation.findUnique({ where: { id: "global" } }),
      tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" }, orderBy: { epoch: "desc" },
      }),
    ]);
    if (!user || user.status !== "active" || user.deletedAt) throw new ForbiddenException("User processing is frozen");
    if (privacy?.status !== "ready") throw new ForbiddenException("Privacy reconciliation is not ready");
    if (!consent?.granted) throw new ForbiddenException("Current health-processing consent is required");
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: user.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return {
      consentEpoch: consent.epoch,
      localDate: `${part("year")}-${part("month")}-${part("day")}`,
    };
  }

  private async evidence(command: CoachSendCommand, gate: CoachGateSnapshot): Promise<CoachEvidence[]> {
    const tx = this.turns.currentTransaction();
    const [row] = await tx.$queryRaw<LockedCoachEvidenceRow[]>`
      SELECT
        action."id" AS "action_id",
        action."action_code" AS "action_code",
        action."local_date" AS "action_local_date",
        action."recommendation_snapshot_id" AS "action_snapshot_id",
        action."status"::text AS "action_status",
        action."is_primary" AS "action_is_primary",
        snapshot."id" AS "snapshot_id",
        snapshot."snapshot_hash" AS "snapshot_hash",
        snapshot."action_code" AS "snapshot_action_code",
        snapshot."safety_class" AS "snapshot_safety_class",
        snapshot."review_status"::text AS "snapshot_review_status",
        snapshot."created_at" AS "snapshot_created_at",
        snapshot."run_id" AS "snapshot_run_id",
        snapshot."provenance_json" AS "snapshot_provenance",
        publication."id" AS "publication_id",
        publication."snapshot_id" AS "publication_snapshot_id",
        publication."action_assignment_id" AS "publication_action_id",
        run."id" AS "run_id",
        run."user_id" AS "run_user_id",
        run."consent_epoch" AS "run_consent_epoch",
        run."status"::text AS "run_status",
        run."local_date" AS "run_local_date",
        run."input_snapshot_id" AS "run_profile_id",
        run."rule_bundle_id" AS "run_bundle_id",
        bundle."status"::text AS "bundle_status",
        profile."id" AS "profile_id"
      FROM "action_assignments" action
      JOIN "recommendation_snapshots" snapshot
        ON snapshot."id" = action."recommendation_snapshot_id"
      JOIN "recommendation_publications" publication
        ON publication."snapshot_id" = snapshot."id"
       AND publication."action_assignment_id" = action."id"
      JOIN "recommendation_runs" run ON run."id" = snapshot."run_id"
      JOIN "rule_bundles" bundle ON bundle."id" = run."rule_bundle_id"
      JOIN "profile_snapshots" profile ON profile."id" = run."input_snapshot_id"
      WHERE action."user_id" = ${command.userId}::uuid
        AND action."status" = 'active'
        AND action."is_primary" = true
      ORDER BY action."created_at" DESC, action."id"
      LIMIT 1
      FOR SHARE OF action, snapshot, publication, run, bundle, profile
    `;
    const latestProfile = await tx.profileSnapshot.findFirst({
      where: { userId: command.userId, consentEpoch: gate.consentEpoch },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    const provenance = row?.snapshot_provenance &&
      typeof row.snapshot_provenance === "object" &&
      !Array.isArray(row.snapshot_provenance)
      ? row.snapshot_provenance
      : null;
    const ruleKey = typeof provenance?.rule_key === "string" ? provenance.rule_key : null;
    if (
      !row || row.snapshot_review_status !== "published" || !row.snapshot_hash ||
      !row.action_code || row.action_code !== row.snapshot_action_code ||
      row.action_snapshot_id !== row.snapshot_id || row.publication_snapshot_id !== row.snapshot_id ||
      row.publication_action_id !== row.action_id || row.snapshot_run_id !== row.run_id ||
      row.run_user_id !== command.userId || row.run_consent_epoch !== gate.consentEpoch ||
      row.run_status !== "completed" || row.bundle_status !== "active" ||
      row.run_profile_id !== row.profile_id || row.run_profile_id !== latestProfile?.id ||
      row.run_local_date.toISOString().slice(0, 10) !== gate.localDate ||
      row.action_local_date.toISOString().slice(0, 10) !== gate.localDate ||
      !row.action_is_primary || row.action_status !== "active" || !ruleKey
    ) return [];
    const [safety] = await tx.$queryRaw<Array<{ safe: boolean }>>`
      SELECT "healthos_lock_coach_rule_evidence"(${ruleKey}) AS "safe"
    `;
    if (!safety?.safe) return [];
    const ageMs = Date.now() - row.snapshot_created_at.getTime();
    return [{
      sourceId: row.snapshot_id,
      sourceType: "recommendation_snapshot",
      snapshotHash: row.snapshot_hash,
      capturedAt: row.snapshot_created_at.toISOString(),
      freshness: ageMs <= 7 * 24 * 60 * 60 * 1_000 ? "current" : "stale",
      actionCode: row.snapshot_action_code,
      safetyClass: ["normal", "caution", "doctor", "blocked"].includes(row.snapshot_safety_class)
        ? row.snapshot_safety_class as CoachEvidence["safetyClass"] : "blocked",
      confirmed: true,
      immutable: true,
    }];
  }

  private threadView(thread: { id: string; clientThreadId: string; status: string; summaryVersion: number; createdAt: Date }) {
    return {
      id: thread.id,
      client_thread_id: thread.clientThreadId,
      status: thread.status,
      summary_version: thread.summaryVersion,
      created_at: thread.createdAt.toISOString(),
    };
  }
}
