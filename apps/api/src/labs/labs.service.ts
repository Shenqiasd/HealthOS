import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { normalizeLabValue } from "@healthos/contracts";
import { Prisma } from "@prisma/client";

import type { AdminPrincipal } from "../admin/admin-principal";
import { canAccessSubject, hasAdminRole } from "../admin/admin-principal";
import type { DatabaseService } from "../database/prisma.service";
import { canonicalSha256 } from "../profile/canonical-json";
import { ProfileEventService } from "../profile/profile-event.service";
import type { LabObjectStore } from "./lab-object-store";
import { labDocumentView, labObservationView } from "./lab-view";

interface IntakeInput {
  idempotencyKey: string;
  sha256: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
}

interface ConfirmationInput {
  idempotencyKey: string;
  expectedVersion: number;
  code: string;
  value: number;
  unit: string;
  reason?: string;
}

function validCorrelationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class LabsService {
  private readonly profileEvents: ProfileEventService;

  constructor(
    private readonly database: DatabaseService,
    private readonly objectStore: LabObjectStore,
    private readonly enabled: boolean,
  ) {
    this.profileEvents = new ProfileEventService(database);
  }

  async initiate(userId: string, correlationId: string, input: IntakeInput) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    const requestHash = canonicalSha256({
      sha256: input.sha256,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
    });
    const row = await this.database.$transaction(async (tx) => {
      const consentEpoch = await this.requireBoundary(tx, userId);
      const replay = await tx.labDocument.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new ConflictException("Lab document idempotency key was reused");
        }
        return replay;
      }
      const duplicate = await tx.labDocument.findUnique({
        where: { userId_sha256: { userId, sha256: input.sha256 } },
      });
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) {
          throw new ConflictException("Lab document digest metadata changed");
        }
        return duplicate;
      }
      const document = await tx.labDocument.create({ data: {
        userId,
        objectKey: `synthetic-labs/${userId}/${input.sha256}`,
        sha256: input.sha256,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        consentEpoch,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      } });
      await tx.auditLog.create({ data: {
        actorId: userId,
        action: "lab.document.intake_created",
        resourceType: "lab_document",
        resourceId: document.id,
        afterHash: requestHash,
        correlationId,
      } });
      return document;
    });
    return labDocumentView(row);
  }

  async finalize(userId: string, documentId: string, correlationId: string) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    const candidate = await this.database.labDocument.findUnique({ where: { id: documentId } });
    if (!candidate || candidate.userId !== userId) throw new NotFoundException("Lab document not found");
    if (candidate.status === "active" || candidate.status === "completed") {
      return labDocumentView(candidate);
    }
    if (candidate.status !== "pending" || candidate.deletedAt) {
      throw new ConflictException("Lab document cannot be finalized");
    }
    let object;
    try {
      object = await this.objectStore.head(candidate.objectKey);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Lab object metadata is unavailable");
    }
    if (
      object.sha256 !== candidate.sha256 ||
      object.mimeType !== candidate.mimeType ||
      object.sizeBytes !== Number(candidate.sizeBytes)
    ) {
      throw new ConflictException("Lab object metadata does not match the intake record");
    }
    const row = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "lab_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
      const document = await tx.labDocument.findUnique({ where: { id: documentId } });
      if (!document || document.userId !== userId) throw new NotFoundException("Lab document not found");
      await this.requireBoundary(tx, userId, document.consentEpoch);
      if (document.status === "active" || document.status === "completed") return document;
      if (document.status !== "pending" || document.deletedAt) {
        throw new ConflictException("Lab document changed before finalization");
      }
      const finalized = await tx.labDocument.update({
        where: { id: document.id },
        data: { status: "active", finalizedAt: new Date(), version: { increment: 1 } },
      });
      await tx.domainOutbox.create({ data: {
        eventType: "lab.document.ready",
        aggregateId: finalized.id,
        userId,
        idempotencyKey: `lab.document.ready:${finalized.id}`,
        payload: { document_id: finalized.id },
        consentRequirements: { create: { purpose: "health_processing", grantEpoch: finalized.consentEpoch } },
      } });
      await tx.auditLog.create({ data: {
        actorId: userId,
        action: "lab.document.finalized",
        resourceType: "lab_document",
        resourceId: finalized.id,
        beforeHash: document.requestHash,
        afterHash: canonicalSha256({ object_head: object, consent_epoch: finalized.consentEpoch }),
        correlationId,
      } });
      return finalized;
    });
    return labDocumentView(row);
  }

  async get(userId: string, documentId: string) {
    this.assertEnabled();
    await this.database.$transaction((tx) => this.requireBoundary(tx, userId), { isolationLevel: "ReadCommitted" });
    const row = await this.database.labDocument.findUnique({
      where: { id: documentId },
      include: { observations: { orderBy: [{ page: "asc" }, { id: "asc" }] } },
    });
    if (!row || row.userId !== userId) throw new NotFoundException("Lab document not found");
    return labDocumentView(row);
  }

  async confirmUser(userId: string, observationId: string, correlationId: string, input: ConfirmationInput) {
    return this.confirm({ type: "user", userId }, observationId, correlationId, input);
  }

  async confirmReviewer(
    principal: AdminPrincipal,
    observationId: string,
    correlationId: string,
    input: ConfirmationInput,
  ) {
    if (!hasAdminRole(principal, ["reviewer", "medical_approver", "admin"])) {
      throw new ForbiddenException("Lab review authority is required");
    }
    if (!input.reason?.trim()) throw new ConflictException("Lab review reason is required");
    return this.confirm({ type: "reviewer", principal }, observationId, correlationId, input);
  }

  private async confirm(
    actor: { type: "user"; userId: string } | { type: "reviewer"; principal: AdminPrincipal },
    observationId: string,
    correlationId: string,
    input: ConfirmationInput,
  ) {
    this.assertEnabled();
    this.assertCorrelation(correlationId);
    const normalized = normalizeLabValue(input.code, input.value, input.unit);
    if (!normalized) throw new ConflictException("Lab value or unit is unsupported");
    const requestHash = canonicalSha256({
      observation_id: observationId,
      expected_version: input.expectedVersion,
      code: normalized.code,
      value: normalized.value,
      unit: normalized.unit,
      actor_type: actor.type,
      reason: input.reason?.trim() ?? null,
    });
    try {
      return await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "lab_observations" WHERE "id" = ${observationId}::uuid FOR UPDATE`;
      const observation = await tx.labObservation.findUnique({
        where: { id: observationId }, include: { document: true },
      });
      if (!observation) throw new NotFoundException("Lab observation not found");
      const userId = actor.type === "user" ? actor.userId : observation.document.userId;
      if (
        observation.document.userId !== userId ||
        (actor.type === "reviewer" && !canAccessSubject(actor.principal, userId))
      ) {
        throw new NotFoundException("Lab observation not found");
      }
      await this.requireBoundary(tx, userId, observation.document.consentEpoch);
      const replay = await tx.labObservationMutation.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash || replay.observationId !== observation.id) {
          throw new ConflictException("Lab confirmation idempotency key was reused");
        }
        return replay.resultJson;
      }
      if (observation.document.status !== "completed" || observation.document.deletedAt) {
        throw new ForbiddenException("Lab document is not available for confirmation");
      }
      if (observation.version !== input.expectedVersion) {
        throw new ConflictException("Lab observation version is stale");
      }
      if (observation.confirmationStatus === "usable" || observation.confirmationStatus === "rejected") {
        throw new ConflictException("Lab observation is already resolved");
      }
      const afterHash = canonicalSha256({
        code: normalized.code,
        normalized_value: normalized.value,
        normalized_unit: normalized.unit,
        evidence_box: observation.evidenceBox,
        page: observation.page,
      });
      const updated = await tx.labObservation.update({
        where: { id: observation.id },
        data: {
          code: normalized.code,
          value: String(input.value),
          unit: input.unit.trim(),
          normalizedValue: normalized.value,
          normalizedUnit: normalized.unit,
          confirmationStatus: "usable",
          dispositionCode: actor.type === "user" ? "user_confirmed" : "reviewer_confirmed",
          observationHash: afterHash,
          version: { increment: 1 },
        },
      });
      await this.profileEvents.appendAuthorized(tx, userId, observation.document.consentEpoch, {
        eventType: "lab_value_corrected",
        source: actor.type === "user" ? "user_confirmed_lab" : "reviewer_confirmed_lab",
        correlationId,
        payload: {
          field_code: normalized.code.toLowerCase(),
          value: normalized.value,
          unit: normalized.unit,
        },
      });
      const reviewerRole = actor.type === "reviewer"
        ? hasAdminRole(actor.principal, ["admin"]) ? "admin"
          : hasAdminRole(actor.principal, ["medical_approver"]) ? "medical_approver" : "reviewer"
        : null;
      await tx.auditLog.create({ data: {
        ...(actor.type === "user" ? { actorId: userId } : {
          adminActorId: actor.principal.actorId,
          actorRole: reviewerRole,
        }),
        action: actor.type === "user" ? "lab.observation.user_confirmed" : "lab.observation.reviewer_confirmed",
        resourceType: "lab_observation",
        resourceId: observation.id,
        beforeHash: observation.observationHash,
        afterHash,
        ...(input.reason ? { reason: input.reason.trim() } : {}),
        correlationId,
        operationVersion: updated.version,
      } });
      const result = labObservationView(updated);
      await tx.labObservationMutation.create({ data: {
        userId,
        observationId: observation.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        resultJson: result as unknown as Prisma.InputJsonObject,
      } });
      return result;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))
      ) {
        throw new ConflictException("Lab observation changed concurrently");
      }
      throw error;
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
        where: { controlType: "kill_switch", controlKey: "labs.ingestion", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" },
      }),
    ]);
    if (!user || user.status !== "active" || user.deletedAt) throw new ForbiddenException("User processing is frozen");
    if (!consent?.granted || consent.epoch !== user.consentEpoch) {
      throw new ForbiddenException("Current health-processing consent is required");
    }
    if (expectedConsentEpoch !== undefined && expectedConsentEpoch !== consent.epoch) {
      throw new ForbiddenException("Lab document consent is stale");
    }
    if (privacy?.status !== "ready") throw new ForbiddenException("Privacy reconciliation is not ready");
    if (!controlEpoch || killSwitch?.active) {
      throw new ServiceUnavailableException("Lab ingestion is disabled");
    }
    return consent.epoch;
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("Lab ingestion is not configured");
  }

  private assertCorrelation(value: string): void {
    if (!validCorrelationId(value)) throw new ConflictException("Valid correlation identifier is required");
  }
}
