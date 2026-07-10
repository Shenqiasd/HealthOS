import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isRuleInput, type RuleInput } from "@healthos/rules";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";
import { canonicalSha256 } from "../profile/canonical-json";

export interface RecommendationRunRequest {
  userId: string;
  localDate: string;
  profileSnapshotId: string;
  ruleInput: unknown;
  factRevisionIds: string[];
  labObservationIds: string[];
  correlationId: string;
}

interface LabInputRow {
  id: string;
  user_id: string;
  confirmation_status: string;
  observation_hash: string;
}

@Injectable()
export class RecommendationRunService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async request(input: RecommendationRunRequest) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) || !isRuleInput(input.ruleInput)) {
      throw new ConflictException("Recommendation request input is invalid");
    }
    const ruleInput: RuleInput = input.ruleInput;
    const localDate = new Date(`${input.localDate}T00:00:00.000Z`);
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: input.userId } });
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId: input.userId, consentType: "health_processing" },
        orderBy: { epoch: "desc" },
      });
      if (!user || user.status !== "active" || user.deletedAt || reconciliation?.status !== "ready" || !consent?.granted) {
        throw new ForbiddenException("Current processing authorization is required");
      }
      const profile = await tx.profileSnapshot.findUnique({ where: { id: input.profileSnapshotId } });
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId: user.id, consentEpoch: consent.epoch },
        orderBy: { version: "desc" },
      });
      if (!profile || profile.userId !== user.id || profile.consentEpoch !== consent.epoch || latestProfile?.id !== profile.id) {
        throw new ConflictException("Profile snapshot does not match current user consent");
      }
      const profileFacts = profile.factsJson;
      const profileRuleInput = profileFacts && typeof profileFacts === "object" && !Array.isArray(profileFacts)
        ? profileFacts.rule_input
        : null;
      if (!isRuleInput(profileRuleInput) || canonicalSha256(profileRuleInput) !== canonicalSha256(ruleInput)) {
        throw new ConflictException("Rule input must match the immutable profile projection");
      }
      const bundle = await tx.ruleBundle.findFirst({ where: { status: "active" } });
      if (!bundle?.bundleDigest) throw new NotFoundException("No active rule bundle is available");

      const facts = await tx.dailyHealthFactRevision.findMany({
        where: { id: { in: input.factRevisionIds } },
        orderBy: { id: "asc" },
      });
      if (facts.length !== new Set(input.factRevisionIds).size || facts.some((fact) => fact.userId !== user.id || fact.localDate > localDate)) {
        throw new ConflictException("Daily fact provenance is incomplete or belongs to another user");
      }
      const labs = input.labObservationIds.length === 0 ? [] : await tx.$queryRaw<LabInputRow[]>`
        SELECT o."id", d."user_id", o."confirmation_status"::text,
          encode(digest(jsonb_build_object(
            'id', o."id", 'document_id', o."document_id", 'code', o."code",
            'value', o."value", 'unit', o."unit", 'normalized_value', o."normalized_value",
            'reference_range', o."reference_range", 'page', o."page",
            'evidence_box', o."evidence_box", 'confidence', o."confidence",
            'confirmation_status', o."confirmation_status"
          )::text, 'sha256'), 'hex') AS "observation_hash"
        FROM "lab_observations" o
        JOIN "lab_documents" d ON d."id" = o."document_id"
        WHERE o."id" = ANY(${input.labObservationIds}::uuid[])
        ORDER BY o."id"
      `;
      if (labs.length !== new Set(input.labObservationIds).size || labs.some((lab) => lab.user_id !== user.id || lab.confirmation_status !== "usable")) {
        throw new ConflictException("Lab provenance is incomplete, unconfirmed, or belongs to another user");
      }

      const inputManifest = {
        profile_snapshot_id: profile.id,
        profile_snapshot_hash: profile.snapshotHash,
        consent_epoch: consent.epoch,
        rule_input: profileRuleInput,
        fact_inputs: facts.map((fact) => ({ id: fact.id, input_hash: fact.inputHash })),
        lab_inputs: labs.map((lab) => ({ id: lab.id, observation_hash: lab.observation_hash })),
        rule_bundle_id: bundle.id,
        rule_bundle_digest: bundle.bundleDigest,
      };
      const existing = await tx.recommendationRun.findUnique({
        where: { userId_localDate: { userId: user.id, localDate } },
      });
      if (existing) {
        if (!existing.inputManifestJson || canonicalSha256(existing.inputManifestJson) !== canonicalSha256(inputManifest)) {
          throw new ConflictException("A different recommendation run already exists for this day");
        }
        return existing;
      }

      const run = await tx.recommendationRun.create({
        data: {
          userId: user.id,
          localDate,
          inputSnapshotId: profile.id,
          ruleBundleId: bundle.id,
          consentEpoch: consent.epoch,
          inputHash: "0".repeat(64),
          inputManifestJson: inputManifest as unknown as Prisma.InputJsonObject,
          correlationId: input.correlationId,
          factInputs: {
            create: facts.map((fact) => ({ factRevisionId: fact.id, inputHash: fact.inputHash })),
          },
          labInputs: {
            create: labs.map((lab) => ({ labObservationId: lab.id, observationHash: lab.observation_hash })),
          },
        },
      });
      await tx.domainOutbox.create({
        data: {
          eventType: "recommendation.run.requested",
          aggregateId: run.id,
          userId: user.id,
          idempotencyKey: `recommendation.run.requested:${run.id}`,
          payload: { recommendation_run_id: run.id },
          consentRequirements: { create: { purpose: "health_processing", grantEpoch: consent.epoch } },
        },
      });
      return run;
    });
  }
}
