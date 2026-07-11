import type {
  SignalCode,
  SignalFreshness,
  SignalState,
  SignalTrend,
} from "@healthos/contracts";
import type { RuleInput } from "@healthos/rules";
import { isRuleInput } from "@healthos/rules";
import type { Prisma, PrismaClient } from "@prisma/client";

const SIGNAL_CODES: SignalCode[] = [
  "sleep_recovery",
  "fatty_liver",
  "uric_acid",
  "waist_weight",
];

export interface DerivedSignalProjection {
  signalCode: SignalCode;
  state: SignalState;
  trend: SignalTrend;
  freshness: SignalFreshness;
  confidence: number;
  drivers: Array<{
    code: "validated_rule_signal";
    source_fact_revision_ids: string[];
  }>;
}

export interface DeriveSignalProjectionInput {
  ruleInput: RuleInput;
  minimumCoverage: number;
  previousStates: Partial<Record<SignalCode, SignalState>>;
  sourceFactRevisionIds: string[];
}

export class PermanentSignalProjectionError extends Error {
  override readonly name = "PermanentSignalProjectionError";
}

function permanentFailure(message: string): never {
  throw new PermanentSignalProjectionError(message);
}

function signalState(input: RuleInput, code: SignalCode): SignalState {
  if (input.freshness === "missing" || input.freshness === "conflicting") return "unknown";
  const value = input.signals[code] ?? "unknown";
  if (value === "normal") return "stable";
  if (value === "elevated") return "watch";
  return "unknown";
}

function signalFreshness(input: RuleInput, minimumCoverage: number): SignalFreshness {
  if (input.freshness === "stale") return "stale";
  if (input.freshness !== "current") return "unknown";
  return minimumCoverage < 1 ? "partial" : "current";
}

function signalTrend(previous: SignalState | undefined, current: SignalState, freshness: SignalFreshness): SignalTrend {
  if ((freshness !== "current" && freshness !== "partial") || !previous || previous === "unknown" || current === "unknown") {
    return "unknown";
  }
  if (previous === current) return "stable";
  return previous === "watch" && current === "stable" ? "improving" : "worsening";
}

export function deriveSignalProjections(input: DeriveSignalProjectionInput): DerivedSignalProjection[] {
  const minimumCoverage = Number.isFinite(input.minimumCoverage)
    ? Math.max(0, Math.min(1, input.minimumCoverage))
    : 0;
  const freshness = signalFreshness(input.ruleInput, minimumCoverage);
  return SIGNAL_CODES.map((signalCode) => {
    const state = signalState(input.ruleInput, signalCode);
    const confidence = state === "unknown" || freshness === "unknown" ? 0 : minimumCoverage;
    return {
      signalCode,
      state,
      trend: signalTrend(input.previousStates[signalCode], state, freshness),
      freshness,
      confidence,
      drivers: [{
        code: "validated_rule_signal",
        source_fact_revision_ids: [...input.sourceFactRevisionIds].sort(),
      }],
    };
  });
}

export function minimumSourceCoverage(values: ReadonlyArray<number | null>): number {
  if (values.length === 0 || values.some((value) => value === null)) return 0;
  const numeric = values as number[];
  return numeric.every((value) => Number.isFinite(value)) ? Math.min(...numeric) : 0;
}

function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export class SignalProjectionWorker {
  constructor(private readonly database: PrismaClient) {}

  async project(recommendationSnapshotId: string) {
    return this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`signals:${recommendationSnapshotId}`}, 0))`;
      const identity = await tx.recommendationPublication.findUnique({
        where: { snapshotId: recommendationSnapshotId },
        select: { snapshot: { select: { run: { select: { userId: true } } } } },
      });
      if (!identity) permanentFailure("Published recommendation snapshot is required");
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${identity.snapshot.run.userId}::uuid FOR UPDATE`;
      const publication = await tx.recommendationPublication.findUnique({
        where: { snapshotId: recommendationSnapshotId },
        include: {
          snapshot: {
            include: {
              run: {
                include: {
                  user: { include: { consents: true } },
                  inputSnapshot: true,
                  ruleBundle: true,
                  factInputs: { include: { factRevision: true } },
                },
              },
            },
          },
        },
      });
      if (!publication || publication.snapshot.reviewStatus !== "published") {
        permanentFailure("Published recommendation snapshot is required");
      }
      const { snapshot } = publication;
      const { run } = snapshot;
      const consent = [...run.user.consents]
        .filter((item) => item.consentType === "health_processing")
        .sort((left, right) => right.epoch - left.epoch)[0];
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId: run.userId, consentEpoch: run.consentEpoch },
        orderBy: { version: "desc" },
      });
      const provenance = jsonObject(snapshot.provenanceJson);
      const ruleKey = typeof provenance?.rule_key === "string" ? provenance.rule_key : null;
      if (!ruleKey) permanentFailure("Signal projection rule provenance is invalid");
      const lockedBundles = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status"
        FROM "rule_bundles"
        WHERE "id" = ${run.ruleBundleId}::uuid
        FOR SHARE
      `;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`signal-safety:rule:${ruleKey}`}, 0))
      `;
      const incident = await tx.safetyIncident.count({ where: { source: `rule:${ruleKey}` } });
      if (reconciliation?.status !== "ready") {
        throw new Error("Signal projection is temporarily unavailable during privacy reconciliation");
      }
      if (
        run.user.status !== "active" || run.user.deletedAt || !consent?.granted ||
        consent.epoch !== run.consentEpoch || latestProfile?.id !== run.inputSnapshotId ||
        lockedBundles[0]?.status !== "active" || incident > 0
      ) permanentFailure("Signal projection provenance is no longer current");
      if (!isRuleInput(snapshot.canonicalRuleInputJson)) {
        permanentFailure("Stored canonical rule input is invalid");
      }
      const existing = await tx.signalSnapshot.findMany({
        where: { recommendationSnapshotId: snapshot.id },
        orderBy: { signalCode: "asc" },
      });
      if (existing.length === SIGNAL_CODES.length) return existing;
      if (existing.length > 0) permanentFailure("Signal projection is incomplete");
      const allHistory = await tx.signalSnapshot.findMany({
        where: {
          userId: run.userId,
          signalCode: { in: SIGNAL_CODES },
        },
        orderBy: [{ localDate: "desc" }, { revision: "desc" }],
      });
      const trendHistory = allHistory.filter((entry) =>
        entry.recommendationSnapshotId !== null && ["stable", "watch", "unknown"].includes(entry.state));
      const previousStates: Partial<Record<SignalCode, SignalState>> = {};
      for (const item of trendHistory.filter((entry) => entry.localDate < run.localDate)) {
        const code = item.signalCode as SignalCode;
        if (!previousStates[code]) previousStates[code] = item.state as SignalState;
      }
      const minimumCoverage = minimumSourceCoverage(run.factInputs.map((item) =>
        item.factRevision.coverage === null ? null : Number(item.factRevision.coverage)));
      const projections = deriveSignalProjections({
        ruleInput: snapshot.canonicalRuleInputJson,
        minimumCoverage,
        previousStates,
        sourceFactRevisionIds: run.factInputs.map((item) => item.factRevisionId),
      });
      for (const projection of projections) {
        const previousRevision = allHistory
          .filter((item) => item.signalCode === projection.signalCode)
          .reduce((maximum, item) => Math.max(maximum, item.revision), 0);
        const sourceProvenance = {
          recommendation_snapshot_id: snapshot.id,
          recommendation_snapshot_hash: snapshot.snapshotHash,
          profile_snapshot_id: run.inputSnapshot.id,
          profile_snapshot_hash: run.inputSnapshot.snapshotHash,
          rule_bundle_id: run.ruleBundle.id,
          rule_bundle_digest: run.ruleBundle.bundleDigest,
          consent_epoch: run.consentEpoch,
          fact_revision_ids: run.factInputs.map((item) => item.factRevisionId).sort(),
          fact_input_hashes: run.factInputs.map((item) => item.inputHash).sort(),
        };
        await tx.signalSnapshot.create({ data: {
          userId: run.userId,
          localDate: run.localDate,
          signalCode: projection.signalCode,
          revision: previousRevision + 1,
          state: projection.state,
          trend: projection.trend,
          confidence: projection.confidence,
          freshness: projection.freshness,
          driversJson: projection.drivers as unknown as Prisma.InputJsonValue,
          provenanceJson: sourceProvenance as unknown as Prisma.InputJsonObject,
          sourceHash: "0".repeat(64),
          recommendationSnapshotId: snapshot.id,
        } });
      }
      return tx.signalSnapshot.findMany({
        where: { recommendationSnapshotId: snapshot.id },
        orderBy: { signalCode: "asc" },
      });
    });
  }
}
