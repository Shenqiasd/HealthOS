import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";

export const RULES_ENGINE_ARTIFACT_DIGEST = "22e19a3848877f16f3a56921f91f8eb1f3a54f21551d3c47569153f748c8d282";

@Injectable()
export class RuleBundleService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async create(version: string, content: Prisma.InputJsonObject) {
    const digestKeys = ["safety_bundle_digest", "localization_bundle_digest", "template_bundle_digest"] as const;
    if (
      !version.trim() ||
      content.rules_engine !== "deterministic-rules-v1" ||
      content.rules_engine_digest !== RULES_ENGINE_ARTIFACT_DIGEST ||
      !Number.isInteger(content.beta_normal_review_percent) ||
      Number(content.beta_normal_review_percent) < 20 ||
      Number(content.beta_normal_review_percent) > 100 ||
      !Array.isArray(content.rules) || content.rules.length === 0 ||
      digestKeys.some((key) => typeof content[key] !== "string" || !/^[a-f0-9]{64}$/.test(content[key]))
    ) {
      throw new BadRequestException("Rule bundle versioned content is required");
    }
    return this.database.ruleBundle.create({
      data: {
        version: version.trim(),
        contentJson: content,
        contentHash: "0".repeat(64),
        bundleDigest: "0".repeat(64),
      },
    });
  }

  async approve(bundleId: string, input: { role: "technical" | "medical"; actorId: string; approvedAt: Date }) {
    if (!input.actorId.trim() || Number.isNaN(input.approvedAt.getTime())) {
      throw new BadRequestException("Valid approval actor and timestamp are required");
    }
    const bundle = await this.database.ruleBundle.findUnique({ where: { id: bundleId } });
    if (!bundle?.bundleDigest) throw new ConflictException("Rule bundle is not approvable");
    await this.database.ruleBundleApproval.create({
      data: {
        ruleBundleId: bundle.id,
        role: input.role,
        actorId: input.actorId.trim(),
        normalizedActor: input.actorId.trim().toLowerCase(),
        bundleDigest: bundle.bundleDigest,
        approvedAt: input.approvedAt,
      },
    });
    return this.database.ruleBundle.findUniqueOrThrow({
      where: { id: bundle.id },
      include: { approvals: { orderBy: { role: "asc" } } },
    });
  }

  async activate(bundleId: string, actorId: string, autoPublishEligible: boolean) {
    if (!actorId.trim()) throw new BadRequestException("Publication actor is required");
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "rule_bundles" ORDER BY "id" FOR UPDATE`;
      const bundle = await tx.ruleBundle.findUniqueOrThrow({ where: { id: bundleId } });
      if (bundle.status !== "approved_not_published") {
        throw new ConflictException("Only an approved unpublished bundle can activate");
      }
      await tx.ruleBundle.updateMany({
        where: { status: "active" },
        data: { status: "superseded", autoPublishEligible: false },
      });
      const activated = await tx.ruleBundle.update({
        where: { id: bundle.id },
        data: {
          status: "active",
          autoPublishEligible,
          publishedBy: actorId.trim(),
          publishedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          action: "rule_bundle.activated",
          resourceType: "rule_bundle",
          resourceId: activated.id,
          afterHash: activated.bundleDigest,
        },
      });
      return activated;
    });
  }

  async rollback(sourceBundleId: string, targetBundleId: string, actorId: string, reasonCode: string) {
    if (!actorId.trim() || !reasonCode.trim() || sourceBundleId === targetBundleId) {
      throw new BadRequestException("Rollback requires distinct bundles, actor, and reason");
    }
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "rule_bundles" ORDER BY "id" FOR UPDATE`;
      const source = await tx.ruleBundle.findUniqueOrThrow({ where: { id: sourceBundleId } });
      const target = await tx.ruleBundle.findUniqueOrThrow({ where: { id: targetBundleId } });
      if (source.status !== "active" || !["superseded", "rolled_back"].includes(target.status)) {
        throw new ConflictException("Rollback source or target state is invalid");
      }
      if (!source.bundleDigest || !target.bundleDigest) throw new ConflictException("Rollback bundle identity is incomplete");
      const event = await tx.ruleBundleRollbackEvent.create({
        data: {
          sourceBundleId: source.id,
          targetBundleId: target.id,
          actorId: actorId.trim(),
          reasonCode: reasonCode.trim(),
          sourceDigest: source.bundleDigest,
          targetDigest: target.bundleDigest,
        },
      });
      await tx.ruleBundle.update({
        where: { id: source.id },
        data: {
          status: "rolled_back",
          autoPublishEligible: false,
          rolledBackAt: new Date(),
          lastRollbackEventId: event.id,
        },
      });
      const restored = await tx.ruleBundle.update({
        where: { id: target.id },
        data: {
          status: "active",
          autoPublishEligible: false,
          publishedBy: actorId.trim(),
          publishedAt: new Date(),
          lastRollbackEventId: event.id,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "rule_bundle.rolled_back",
          resourceType: "rule_bundle",
          resourceId: source.id,
          beforeHash: source.bundleDigest,
          afterHash: restored.bundleDigest,
        },
      });
      return { event, restored };
    });
  }
}
