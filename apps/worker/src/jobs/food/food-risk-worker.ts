import { createHash, randomUUID } from "node:crypto";

import {
  FOOD_DISH_CODES,
  FOOD_RISK_LABELS,
  type FoodDishCode,
  type FoodMealCompleteness,
  type FoodMealPresence,
  type FoodRiskLabelCode,
  type FoodRiskLevel,
} from "@healthos/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  FoodVisionProviderUnavailableError,
  type FoodVisionDish,
  type FoodVisionLabel,
  type FoodVisionProvider,
  type FoodVisionResult,
} from "./food-vision-provider";

interface WorkerConfig {
  leaseSeconds: number;
  timeoutMilliseconds: number;
}

class ProviderOutputError extends Error {}
class VisionTimeoutError extends Error {}

interface PreparedDish {
  code: FoodDishCode;
  confidence: number;
  evidence: Prisma.InputJsonObject;
  dispositionCode: "visible" | "needs_confirmation" | "abstained";
  candidateHash: string;
}

interface PreparedLabel {
  label: FoodRiskLabelCode;
  level: FoodRiskLevel;
  confidence: number;
  evidence: Prisma.InputJsonObject;
  dispositionCode: "visible" | "needs_confirmation" | "abstained";
  labelHash: string;
}

export interface PreparedFoodResult {
  mealPresence: FoodMealPresence;
  mealCompleteness: FoodMealCompleteness;
  overallConfidence: number;
  dispositionCode: "visible" | "needs_confirmation" | "no_food" | "unsupported" | "abstained";
  dishes: PreparedDish[];
  labels: PreparedLabel[];
  resultHash: string;
}

const DISH_SET = new Set<string>(FOOD_DISH_CODES);
const LABEL_SET = new Set<string>(FOOD_RISK_LABELS);
const LEVEL_SET = new Set<string>(["unknown", "low", "medium", "high"]);
const PRESENCE_SET = new Set<string>(["food", "no_food", "uncertain"]);
const COMPLETENESS_SET = new Set<string>(["complete", "cropped", "unknown", "unsupported"]);
const FORBIDDEN_KEY = /(^|_)(kcal|calorie|calories|protein|proteins|carb|carbs|carbohydrate|carbohydrates|fat|fats|macro|macros|macronutrient|macronutrients|diagnosis|diagnostic|retrain|retraining)($|_)/i;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    if (FORBIDDEN_KEY.test(normalized)) throw new ProviderOutputError("Food provider output contains forbidden fields");
    assertNoForbiddenKeys(nested);
  }
}

function validEvidence(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["x", "y", "width", "height"])) {
    return false;
  }
  const box = value as Record<string, unknown>;
  const { x, y, width, height } = box;
  return [x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    (x as number) >= 0 && (y as number) >= 0 && (width as number) > 0 && (height as number) > 0 &&
    (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1;
}

function validConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateDish(raw: FoodVisionDish): asserts raw is FoodVisionDish & { code: FoodDishCode } {
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["code", "confidence", "evidenceBox"]) ||
    !DISH_SET.has(raw.code) || !validConfidence(raw.confidence) || !validEvidence(raw.evidenceBox)
  ) {
    throw new ProviderOutputError("Food dish candidate is invalid");
  }
}

function validateLabel(raw: FoodVisionLabel): asserts raw is FoodVisionLabel & { label: FoodRiskLabelCode; level: FoodRiskLevel } {
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["label", "level", "confidence", "evidenceBox"]) ||
    !LABEL_SET.has(raw.label) || !LEVEL_SET.has(raw.level) || !validConfidence(raw.confidence) || !validEvidence(raw.evidenceBox)
  ) {
    throw new ProviderOutputError("Food risk label is invalid");
  }
}

export function prepareFoodRiskResult(
  raw: FoodVisionResult,
  disabledLabels: ReadonlySet<FoodRiskLabelCode> = new Set(),
): PreparedFoodResult {
  assertNoForbiddenKeys(raw);
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) ||
    !exactKeys(raw, ["mealPresence", "mealCompleteness", "overallConfidence", "dishes", "labels"]) ||
    !PRESENCE_SET.has(raw.mealPresence) || !COMPLETENESS_SET.has(raw.mealCompleteness) ||
    !validConfidence(raw.overallConfidence) || !Array.isArray(raw.dishes) || !Array.isArray(raw.labels) ||
    raw.dishes.length > 8 || raw.labels.length > 5
  ) {
    throw new ProviderOutputError("Food provider response is invalid");
  }
  if (
    (raw.mealPresence === "food" && raw.dishes.length === 0) ||
    (raw.mealPresence !== "food" && (raw.dishes.length > 0 || raw.labels.length > 0)) ||
    (raw.mealCompleteness === "unsupported" && raw.mealPresence !== "uncertain")
  ) {
    throw new ProviderOutputError("Food provider response state is inconsistent");
  }

  const dishCodes = new Set<string>();
  const labelCodes = new Set<string>();
  for (const dish of raw.dishes) {
    validateDish(dish);
    if (dishCodes.has(dish.code)) throw new ProviderOutputError("Food dish candidates contain duplicates");
    dishCodes.add(dish.code);
  }
  for (const label of raw.labels) {
    validateLabel(label);
    if (labelCodes.has(label.label)) throw new ProviderOutputError("Food risk labels contain duplicates");
    labelCodes.add(label.label);
  }

  const needsConfirmation = raw.mealPresence === "food" &&
    (raw.mealCompleteness !== "complete" || raw.overallConfidence < 0.9);
  const dishes: PreparedDish[] = raw.dishes.map((dish) => {
    const dispositionCode = needsConfirmation || dish.confidence < 0.9 ? "needs_confirmation" : "visible";
    const evidence = dish.evidenceBox as unknown as Prisma.InputJsonObject;
    return {
      code: dish.code as FoodDishCode,
      confidence: dish.confidence,
      evidence,
      dispositionCode,
      candidateHash: sha256({ code: dish.code, confidence: dish.confidence, evidence, dispositionCode }),
    };
  });
  const labels: PreparedLabel[] = raw.labels
    .filter((label) => !disabledLabels.has(label.label as FoodRiskLabelCode))
    .map((label) => {
      const dispositionCode = label.level === "unknown"
        ? "abstained"
        : needsConfirmation || label.confidence < 0.9 ? "needs_confirmation" : "visible";
      const evidence = label.evidenceBox as unknown as Prisma.InputJsonObject;
      return {
        label: label.label as FoodRiskLabelCode,
        level: label.level as FoodRiskLevel,
        confidence: label.confidence,
        evidence,
        dispositionCode,
        labelHash: sha256({ label: label.label, level: label.level, confidence: label.confidence, evidence, dispositionCode }),
      };
    });

  const dispositionCode = raw.mealCompleteness === "unsupported" ? "unsupported"
    : raw.mealPresence === "no_food" ? "no_food"
      : needsConfirmation ? "needs_confirmation"
        : labels.some((label) => label.dispositionCode === "visible") ? "visible"
          : labels.length > 0 ? "needs_confirmation" : "abstained";
  const resultIdentity = {
    mealPresence: raw.mealPresence,
    mealCompleteness: raw.mealCompleteness,
    overallConfidence: raw.overallConfidence,
    dispositionCode,
    dishes: dishes.map((dish) => dish.candidateHash),
    labels: labels.map((label) => label.labelHash),
  };
  return {
    mealPresence: raw.mealPresence,
    mealCompleteness: raw.mealCompleteness,
    overallConfidence: raw.overallConfidence,
    dispositionCode,
    dishes,
    labels,
    resultHash: sha256(resultIdentity),
  };
}

export class FoodRiskWorker {
  private readonly consumer = "food-risk-v1";

  constructor(
    private readonly database: PrismaClient,
    private readonly provider: FoodVisionProvider,
    private readonly config: WorkerConfig,
  ) {}

  async claim(outboxId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: outboxId,
        eventType: "food.scan.ready",
        availableAt: { lte: now },
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "leased", leaseUntil: { lt: now } },
        ],
      },
      data: { status: "leased", leaseToken, leaseUntil: new Date(now.getTime() + this.config.leaseSeconds * 1_000) },
    });
    if (claimed.count !== 1) throw new Error("Food scan message is not claimable");
    return this.database.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  }

  async process(outboxId: string, leaseToken: string): Promise<void> {
    const observed = await this.database.domainOutbox.findUnique({
      where: { id: outboxId }, include: { consentRequirements: true },
    });
    if (!observed) throw new Error("Food scan message not found");
    const prior = await this.database.consumerInbox.findUnique({
      where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
    });
    if (prior) return;
    this.assertLease(observed, leaseToken);
    const scanId = this.scanId(observed.payload, observed.aggregateId);
    const scan = await this.database.foodScan.findUnique({ where: { id: scanId } });
    if (!scan || !await this.isAuthorized(scan, observed.consentRequirements)) {
      await this.suppress(outboxId, leaseToken, scanId);
      return;
    }

    let raw: FoodVisionResult;
    try {
      raw = await this.withTimeout(this.provider.analyze({
        scanId: scan.id,
        objectKey: scan.objectKey,
        sha256: scan.sha256,
        mimeType: scan.mimeType,
        sizeBytes: Number(scan.sizeBytes),
      }));
      prepareFoodRiskResult(raw);
    } catch (error) {
      await this.fail(outboxId, leaseToken, scanId, this.failureCode(error));
      return;
    }

    await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${scan.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "food_scans" WHERE "id" = ${scanId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "domain_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
      const [message, current] = await Promise.all([
        tx.domainOutbox.findUniqueOrThrow({ where: { id: outboxId }, include: { consentRequirements: true } }),
        tx.foodScan.findUniqueOrThrow({ where: { id: scanId } }),
      ]);
      const processed = await tx.consumerInbox.findUnique({
        where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
      });
      if (processed) return;
      this.assertLease(message, leaseToken);
      if (!await this.isAuthorized(current, message.consentRequirements, tx) || current.status !== "active" || current.deletedAt) {
        await tx.domainOutbox.update({
          where: { id: outboxId }, data: { status: "suppressed", leaseToken: null, leaseUntil: null },
        });
        if (current.status !== "deleted") {
          await tx.foodScan.update({
            where: { id: current.id }, data: { status: "suppressed", failureCode: "authorization_changed" },
          });
        }
        return;
      }
      if (
        await tx.foodRiskLabel.count({ where: { foodScanId: scanId } }) !== 0 ||
        await tx.foodDishCandidate.count({ where: { foodScanId: scanId } }) !== 0
      ) {
        throw new ProviderOutputError("Food scan already has analysis results");
      }
      const disabledLabels = await this.disabledLabels(tx);
      const prepared = prepareFoodRiskResult(raw, disabledLabels);
      if (prepared.dishes.length > 0) {
        await tx.foodDishCandidate.createMany({ data: prepared.dishes.map((dish) => ({
          foodScanId: scanId,
          code: dish.code,
          confidence: dish.confidence,
          evidence: dish.evidence,
          dispositionCode: dish.dispositionCode,
          candidateHash: dish.candidateHash,
        })) });
      }
      if (prepared.labels.length > 0) {
        await tx.foodRiskLabel.createMany({ data: prepared.labels.map((label) => ({
          foodScanId: scanId,
          label: label.label,
          level: label.level,
          confidence: label.confidence,
          evidence: label.evidence,
          dispositionCode: label.dispositionCode,
          labelHash: label.labelHash,
        })) });
      }
      await tx.foodScan.update({
        where: { id: current.id },
        data: {
          status: "completed",
          failureCode: null,
          modelVersion: "synthetic-food-v1",
          overallConfidence: prepared.overallConfidence,
          mealPresence: prepared.mealPresence,
          mealCompleteness: prepared.mealCompleteness,
          dispositionCode: prepared.dispositionCode,
          resultHash: prepared.resultHash,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({ data: {
        action: "food.scan.analyzed",
        resourceType: "food_scan",
        resourceId: current.id,
        afterHash: prepared.resultHash,
        operationVersion: current.version + 1,
      } });
      await tx.consumerInbox.create({ data: {
        consumer: this.consumer,
        messageId: outboxId,
        resultHash: prepared.resultHash,
      } });
      await tx.domainOutbox.update({
        where: { id: outboxId }, data: { status: "sent", leaseToken: null, leaseUntil: null },
      });
    });
  }

  private async disabledLabels(client: PrismaClient | Prisma.TransactionClient): Promise<Set<FoodRiskLabelCode>> {
    const revisions = await client.safetyControlRevision.findMany({
      where: {
        controlType: "kill_switch",
        controlKey: { in: FOOD_RISK_LABELS.map((label) => `food.label.${label}`) },
        scopeType: "global",
        scopeId: "*",
      },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
    const resolved = new Map<string, boolean>();
    for (const revision of revisions) {
      if (!resolved.has(revision.controlKey)) resolved.set(revision.controlKey, revision.active);
    }
    return new Set(FOOD_RISK_LABELS.filter((label) => resolved.get(`food.label.${label}`) === true));
  }

  private async isAuthorized(
    scan: { userId: string; consentEpoch: number; status: string; deletedAt: Date | null },
    requirements: readonly { purpose: string; grantEpoch: number }[],
    client: PrismaClient | Prisma.TransactionClient = this.database,
  ): Promise<boolean> {
    const [user, consent, privacy, epoch, killSwitch] = await Promise.all([
      client.user.findUnique({ where: { id: scan.userId } }),
      client.consentRecord.findFirst({ where: { userId: scan.userId, consentType: "health_processing" }, orderBy: { epoch: "desc" } }),
      client.privacyReconciliation.findUnique({ where: { id: "global" } }),
      client.safetyControlEpoch.findUnique({ where: { id: "global" } }),
      client.safetyControlRevision.findFirst({
        where: { controlType: "kill_switch", controlKey: "food.scan", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" },
      }),
    ]);
    const requirement = requirements.find((item) => item.purpose === "health_processing");
    return Boolean(
      user && user.status === "active" && !user.deletedAt &&
      consent?.granted && consent.epoch === user.consentEpoch && consent.epoch === scan.consentEpoch &&
      requirement?.grantEpoch === scan.consentEpoch && privacy?.status === "ready" &&
      epoch && !killSwitch?.active && scan.status === "active" && !scan.deletedAt,
    );
  }

  private async suppress(outboxId: string, leaseToken: string, scanId: string): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await tx.domainOutbox.updateMany({
        where: { id: outboxId, status: "leased", leaseToken },
        data: { status: "suppressed", leaseToken: null, leaseUntil: null },
      });
      await tx.foodScan.updateMany({
        where: { id: scanId, status: { not: "deleted" } },
        data: { status: "suppressed", failureCode: "authorization_changed" },
      });
    });
  }

  private async fail(outboxId: string, leaseToken: string, scanId: string, failureCode: string): Promise<void> {
    const message = await this.database.domainOutbox.findUnique({
      where: { id: outboxId }, include: { consentRequirements: true },
    });
    const scan = await this.database.foodScan.findUnique({ where: { id: scanId } });
    if (!message || !scan || !await this.isAuthorized(scan, message.consentRequirements)) {
      await this.suppress(outboxId, leaseToken, scanId);
      return;
    }
    await this.database.$transaction(async (tx) => {
      await tx.domainOutbox.updateMany({
        where: { id: outboxId, status: "leased", leaseToken },
        data: { status: "failed", leaseToken: null, leaseUntil: null },
      });
      await tx.foodScan.updateMany({
        where: { id: scanId, status: "active" }, data: { status: "failed", failureCode },
      });
    });
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VisionTimeoutError("Food vision timed out")), this.config.timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private failureCode(error: unknown): string {
    if (error instanceof VisionTimeoutError) return "vision_timeout";
    if (error instanceof FoodVisionProviderUnavailableError) return "provider_unconfigured";
    if (error instanceof ProviderOutputError) return "provider_output_invalid";
    return "vision_failed";
  }

  private scanId(value: Prisma.JsonValue, aggregateId: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.scan_id !== aggregateId) {
      throw new ProviderOutputError("Food scan message identity is invalid");
    }
    return aggregateId;
  }

  private assertLease(message: { status: string; leaseToken: string | null; leaseUntil: Date | null }, token: string): void {
    if (message.status !== "leased" || message.leaseToken !== token || !message.leaseUntil || message.leaseUntil <= new Date()) {
      throw new Error("Food scan lease is stale");
    }
  }
}
