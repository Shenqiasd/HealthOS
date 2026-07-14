import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { FoodCorrectionRequest, FoodScanIntakeRequest } from "@healthos/contracts";
import { Prisma } from "@prisma/client";

import type { DatabaseService } from "../database/prisma.service";
import { canonicalSha256 } from "../profile/canonical-json";
import type { FoodObjectStore } from "./food-object-store";
import { foodScanView } from "./food-view";

function validCorrelationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const includeFoodScan = {
  dishCandidates: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  labels: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  corrections: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 1 },
};

export class FoodService {
  constructor(
    private readonly database: DatabaseService,
    private readonly objectStore: FoodObjectStore,
    private readonly enabled: boolean,
  ) {}

  async initiate(userId: string, correlationId: string, input: FoodScanIntakeRequest) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    const capturedAt = new Date(input.captured_at);
    const requestHash = canonicalSha256({
      sha256: input.sha256,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      captured_at: capturedAt.toISOString(),
    });
    const row = await this.database.$transaction(async (tx) => {
      const consentEpoch = await this.requireBoundary(tx, userId);
      const replay = await tx.foodScan.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotency_key } },
        include: includeFoodScan,
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException("Food scan idempotency key was reused");
        return replay;
      }
      const duplicate = await tx.foodScan.findUnique({
        where: { userId_sha256: { userId, sha256: input.sha256 } },
        include: includeFoodScan,
      });
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) throw new ConflictException("Food image digest metadata changed");
        return duplicate;
      }
      const scan = await tx.foodScan.create({
        data: {
          userId,
          objectKey: `synthetic-food/${userId}/${input.sha256}`,
          sha256: input.sha256,
          mimeType: input.mime_type,
          sizeBytes: BigInt(input.size_bytes),
          capturedAt,
          consentEpoch,
          idempotencyKey: input.idempotency_key,
          requestHash,
        },
        include: includeFoodScan,
      });
      await tx.auditLog.create({ data: {
        actorId: userId,
        action: "food.scan.intake_created",
        resourceType: "food_scan",
        resourceId: scan.id,
        afterHash: requestHash,
        correlationId,
      } });
      return scan;
    });
    return foodScanView(row);
  }

  async finalize(userId: string, scanId: string, correlationId: string) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    const candidate = await this.database.foodScan.findUnique({ where: { id: scanId } });
    if (!candidate || candidate.userId !== userId) throw new NotFoundException("Food scan not found");
    if (candidate.status === "active" || candidate.status === "completed") return this.get(userId, scanId);
    if (candidate.status !== "pending" || candidate.deletedAt) throw new ConflictException("Food scan cannot be finalized");

    let object;
    try {
      object = await this.objectStore.head(candidate.objectKey);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Food object metadata is unavailable");
    }
    if (
      object.sha256 !== candidate.sha256 ||
      object.mimeType !== candidate.mimeType ||
      object.sizeBytes !== Number(candidate.sizeBytes)
    ) {
      throw new ConflictException("Food object metadata does not match the intake record");
    }

    const row = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "food_scans" WHERE "id" = ${scanId}::uuid FOR UPDATE`;
      const scan = await tx.foodScan.findUnique({ where: { id: scanId }, include: includeFoodScan });
      if (!scan || scan.userId !== userId) throw new NotFoundException("Food scan not found");
      await this.requireBoundary(tx, userId, scan.consentEpoch);
      if (scan.status === "active" || scan.status === "completed") return scan;
      if (scan.status !== "pending" || scan.deletedAt) throw new ConflictException("Food scan changed before finalization");
      const finalized = await tx.foodScan.update({
        where: { id: scan.id },
        data: { status: "active", finalizedAt: new Date(), version: { increment: 1 } },
        include: includeFoodScan,
      });
      await tx.domainOutbox.create({ data: {
        eventType: "food.scan.ready",
        aggregateId: finalized.id,
        userId,
        idempotencyKey: `food.scan.ready:${finalized.id}`,
        payload: { scan_id: finalized.id },
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: finalized.consentEpoch } },
      } });
      await tx.auditLog.create({ data: {
        actorId: userId,
        action: "food.scan.finalized",
        resourceType: "food_scan",
        resourceId: finalized.id,
        beforeHash: scan.requestHash,
        afterHash: canonicalSha256({ object_head: object, consent_epoch: finalized.consentEpoch }),
        correlationId,
      } });
      return finalized;
    });
    return foodScanView(row);
  }

  async get(userId: string, scanId: string) {
    this.assertEnabled();
    await this.database.$transaction((tx) => this.requireBoundary(tx, userId), { isolationLevel: "ReadCommitted" });
    const row = await this.database.foodScan.findUnique({ where: { id: scanId }, include: includeFoodScan });
    if (!row || row.userId !== userId) throw new NotFoundException("Food scan not found");
    return foodScanView(row);
  }

  async correct(userId: string, scanId: string, correlationId: string, input: FoodCorrectionRequest) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    this.assertCorrectionShape(input);
    const requestHash = canonicalSha256({
      scan_id: scanId,
      expected_version: input.expected_version,
      meal_presence: input.meal_presence,
      meal_completeness: input.meal_completeness,
      dish_codes: input.dish_codes,
      labels: input.labels,
      reason: input.reason.trim(),
    });
    try {
      return await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "food_scans" WHERE "id" = ${scanId}::uuid FOR UPDATE`;
        const scan = await tx.foodScan.findUnique({ where: { id: scanId }, include: includeFoodScan });
        if (!scan || scan.userId !== userId) throw new NotFoundException("Food scan not found");
        await this.requireBoundary(tx, userId, scan.consentEpoch);
        const replay = await tx.foodCorrectionEvent.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotency_key } },
        });
        if (replay) {
          if (replay.foodScanId !== scanId || replay.requestHash !== requestHash) {
            throw new ConflictException("Food correction idempotency key was reused");
          }
          return replay.resultJson;
        }
        if (scan.status !== "completed" || scan.deletedAt) throw new ForbiddenException("Food scan is not correctable");
        if (scan.version !== input.expected_version) throw new ConflictException("Food scan version is stale");

        const eventId = randomUUID();
        const createdAt = new Date();
        const updated = await tx.foodScan.update({
          where: { id: scan.id },
          data: {
            mealPresence: input.meal_presence,
            mealCompleteness: input.meal_completeness,
            dispositionCode: "user_confirmed",
            version: { increment: 1 },
          },
          include: { dishCandidates: includeFoodScan.dishCandidates, labels: includeFoodScan.labels, corrections: false },
        });
        const correction = {
          id: eventId,
          meal_presence: input.meal_presence,
          meal_completeness: input.meal_completeness,
          dish_codes: input.dish_codes,
          labels: input.labels,
          created_at: createdAt.toISOString(),
        };
        const result = foodScanView({ ...updated, corrections: [{
          id: eventId,
          userId,
          foodScanId: scanId,
          idempotencyKey: input.idempotency_key,
          requestHash,
          expectedVersion: input.expected_version,
          mealPresence: input.meal_presence,
          mealCompleteness: input.meal_completeness,
          dishCodes: input.dish_codes,
          labelsJson: input.labels as unknown as Prisma.JsonArray,
          reasonHash: canonicalSha256(input.reason.trim()),
          resultJson: {},
          createdAt,
        }] });
        await tx.foodCorrectionEvent.create({ data: {
          id: eventId,
          userId,
          foodScanId: scanId,
          idempotencyKey: input.idempotency_key,
          requestHash,
          expectedVersion: input.expected_version,
          mealPresence: input.meal_presence,
          mealCompleteness: input.meal_completeness,
          dishCodes: input.dish_codes,
          labelsJson: input.labels as unknown as Prisma.InputJsonArray,
          reasonHash: canonicalSha256(input.reason.trim()),
          resultJson: result as unknown as Prisma.InputJsonObject,
          createdAt,
        } });
        await tx.auditLog.create({ data: {
          actorId: userId,
          action: "food.scan.user_corrected",
          resourceType: "food_scan",
          resourceId: scan.id,
          beforeHash: scan.resultHash,
          afterHash: canonicalSha256(correction),
          correlationId,
          operationVersion: updated.version,
        } });
        return result;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))
      ) {
        throw new ConflictException("Food scan changed concurrently");
      }
      throw error;
    }
  }

  private assertCorrectionShape(input: FoodCorrectionRequest): void {
    if (input.meal_presence === "food" && input.dish_codes.length === 0) {
      throw new ConflictException("Food confirmation requires at least one allowlisted dish");
    }
    if (input.meal_presence !== "food" && (input.dish_codes.length > 0 || input.labels.length > 0)) {
      throw new ConflictException("Non-food or uncertain correction cannot contain labels or dishes");
    }
  }

  private async requireBoundary(
    tx: Prisma.TransactionClient,
    userId: string,
    expectedConsentEpoch?: number,
  ): Promise<number> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
    const [user, consent, privacy, controlEpoch, killSwitch] = await Promise.all([
      tx.user.findUnique({ where: { id: userId } }),
      tx.consentRecord.findFirst({ where: { userId, consentType: "health_processing" }, orderBy: { epoch: "desc" } }),
      tx.privacyReconciliation.findUnique({ where: { id: "global" } }),
      tx.safetyControlEpoch.findUnique({ where: { id: "global" } }),
      tx.safetyControlRevision.findFirst({
        where: { controlType: "kill_switch", controlKey: "food.scan", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" },
      }),
    ]);
    if (!user || user.status !== "active" || user.deletedAt) throw new ForbiddenException("User processing is frozen");
    if (!consent?.granted || consent.epoch !== user.consentEpoch) {
      throw new ForbiddenException("Current health-processing consent is required");
    }
    if (expectedConsentEpoch !== undefined && expectedConsentEpoch !== consent.epoch) {
      throw new ForbiddenException("Food scan consent is stale");
    }
    if (privacy?.status !== "ready") throw new ForbiddenException("Privacy reconciliation is not ready");
    if (!controlEpoch || killSwitch?.active) throw new ServiceUnavailableException("Food scanning is disabled");
    return consent.epoch;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("Food scanning is not configured");
  }

  private assertCorrelation(value: string): void {
    if (!validCorrelationId(value)) throw new ConflictException("Valid correlation identifier is required");
  }
}
