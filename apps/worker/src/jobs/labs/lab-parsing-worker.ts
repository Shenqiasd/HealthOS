import { createHash, randomUUID } from "node:crypto";

import { normalizeLabValue } from "@healthos/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  LabProviderUnavailableError,
  type LabParserObservation,
  type LabParserProvider,
} from "./lab-parser-provider";

interface WorkerConfig {
  leaseSeconds: number;
  timeoutMilliseconds: number;
}

class ProviderOutputError extends Error {}
class ParserTimeoutError extends Error {}

interface PreparedObservation {
  code: string;
  value: string;
  unit: string;
  normalizedValue: number | null;
  normalizedUnit: string | null;
  referenceRange: string | null;
  page: number;
  evidenceBox: Prisma.InputJsonObject;
  confidence: number;
  dispositionCode: string;
  observationHash: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validEvidence(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const box = value as Record<string, unknown>;
  if (Object.keys(box).sort().join(",") !== "height,width,x,y") return false;
  const { x, y, width, height } = box;
  return [x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    (x as number) >= 0 && (y as number) >= 0 && (width as number) > 0 && (height as number) > 0 &&
    (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1;
}

function validateObservation(raw: LabParserObservation): void {
  if (
    typeof raw.code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.code) ||
    typeof raw.value !== "string" || raw.value.length === 0 || raw.value.length > 64 ||
    typeof raw.unit !== "string" || raw.unit.length === 0 || raw.unit.length > 32 ||
    !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
    !Number.isInteger(raw.page) || raw.page < 1 || raw.page > 500 ||
    !validEvidence(raw.evidenceBox) ||
    (raw.referenceRange !== undefined && (typeof raw.referenceRange !== "string" || raw.referenceRange.length > 80))
  ) {
    throw new ProviderOutputError("Lab parser output is invalid");
  }
}

export function prepareLabObservations(raw: readonly LabParserObservation[]): PreparedObservation[] {
  if (raw.length > 64) throw new ProviderOutputError("Lab parser returned too many observations");
  const prepared = raw.map((item) => {
    validateObservation(item);
    const code = item.code.trim().toUpperCase();
    const normalized = normalizeLabValue(code, item.value, item.unit);
    const evidenceBox = item.evidenceBox as unknown as Prisma.InputJsonObject;
    const dispositionCode = normalized
      ? item.confidence < 0.98 ? "low_confidence" : "awaiting_confirmation"
      : "unsupported_field_or_unit";
    const normalizedValue = normalized?.value ?? null;
    const normalizedUnit = normalized?.unit ?? null;
    return {
      code,
      value: item.value,
      unit: item.unit,
      normalizedValue,
      normalizedUnit,
      referenceRange: item.referenceRange ?? null,
      page: item.page,
      evidenceBox,
      confidence: item.confidence,
      dispositionCode,
      observationHash: sha256({
        code, value: item.value, unit: item.unit, normalizedValue, normalizedUnit,
        page: item.page, evidenceBox, confidence: item.confidence,
      }),
    };
  });

  const signatures = new Map<string, Set<string>>();
  for (const row of prepared) {
    const values = signatures.get(row.code) ?? new Set<string>();
    values.add(`${row.normalizedValue ?? "unsupported"}:${row.normalizedUnit ?? "unsupported"}`);
    signatures.set(row.code, values);
  }
  return prepared.map((row) => signatures.get(row.code)!.size > 1
    ? {
      ...row,
      normalizedValue: null,
      normalizedUnit: null,
      dispositionCode: "conflicting_field",
      observationHash: sha256({ ...row, normalizedValue: null, normalizedUnit: null, dispositionCode: "conflicting_field" }),
    }
    : row);
}

export class LabParsingWorker {
  private readonly consumer = "lab-parser-v1";

  constructor(
    private readonly database: PrismaClient,
    private readonly provider: LabParserProvider,
    private readonly config: WorkerConfig,
  ) {}

  async claim(outboxId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: outboxId,
        eventType: "lab.document.ready",
        availableAt: { lte: now },
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "leased", leaseUntil: { lt: now } },
        ],
      },
      data: { status: "leased", leaseToken, leaseUntil: new Date(now.getTime() + this.config.leaseSeconds * 1_000) },
    });
    if (claimed.count !== 1) throw new Error("Lab parse message is not claimable");
    return this.database.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  }

  async process(outboxId: string, leaseToken: string): Promise<void> {
    const observed = await this.database.domainOutbox.findUnique({
      where: { id: outboxId }, include: { consentRequirements: true },
    });
    if (!observed) throw new Error("Lab parse message not found");
    const prior = await this.database.consumerInbox.findUnique({
      where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
    });
    if (prior) return;
    this.assertLease(observed, leaseToken);
    const documentId = this.documentId(observed.payload, observed.aggregateId);
    const document = await this.database.labDocument.findUnique({ where: { id: documentId } });
    if (!document || !await this.isAuthorized(document, observed.consentRequirements)) {
      await this.suppress(outboxId, leaseToken, documentId);
      return;
    }

    let prepared: PreparedObservation[];
    try {
      const parsed = await this.withTimeout(this.provider.parse({
        documentId: document.id,
        objectKey: document.objectKey,
        sha256: document.sha256,
        mimeType: document.mimeType,
        sizeBytes: Number(document.sizeBytes),
      }));
      if (!parsed || !Array.isArray(parsed.observations)) throw new ProviderOutputError("Lab parser response is invalid");
      prepared = prepareLabObservations(parsed.observations);
    } catch (error) {
      await this.fail(outboxId, leaseToken, documentId, this.failureCode(error));
      return;
    }

    await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${document.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "lab_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "domain_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
      const [message, current] = await Promise.all([
        tx.domainOutbox.findUniqueOrThrow({ where: { id: outboxId }, include: { consentRequirements: true } }),
        tx.labDocument.findUniqueOrThrow({ where: { id: documentId } }),
      ]);
      const processed = await tx.consumerInbox.findUnique({
        where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
      });
      if (processed) return;
      this.assertLease(message, leaseToken);
      if (!await this.isAuthorized(current, message.consentRequirements, tx) || current.status !== "active" || current.deletedAt) {
        await tx.domainOutbox.update({ where: { id: outboxId }, data: { status: "suppressed", leaseToken: null, leaseUntil: null } });
        if (current.status !== "deleted") {
          await tx.labDocument.update({ where: { id: current.id }, data: { status: "suppressed", failureCode: "authorization_changed" } });
        }
        return;
      }
      if (await tx.labObservation.count({ where: { documentId } }) !== 0) {
        throw new ProviderOutputError("Lab document already has parse results");
      }
      if (prepared.length > 0) {
        await tx.labObservation.createMany({ data: prepared.map((row) => ({
          documentId,
          code: row.code,
          value: row.value,
          unit: row.unit,
          normalizedValue: row.normalizedValue,
          normalizedUnit: row.normalizedUnit,
          referenceRange: row.referenceRange,
          page: row.page,
          evidenceBox: row.evidenceBox,
          confidence: row.confidence,
          confirmationStatus: "needs_confirmation",
          dispositionCode: row.dispositionCode,
          observationHash: row.observationHash,
        })) });
      }
      const resultHash = sha256(prepared.map((row) => row.observationHash).sort());
      await tx.labDocument.update({
        where: { id: current.id },
        data: { status: "completed", failureCode: null, version: { increment: 1 } },
      });
      await tx.auditLog.create({ data: {
        action: "lab.document.parsed",
        resourceType: "lab_document",
        resourceId: current.id,
        afterHash: resultHash,
        operationVersion: current.version + 1,
      } });
      await tx.consumerInbox.create({ data: { consumer: this.consumer, messageId: outboxId, resultHash } });
      await tx.domainOutbox.update({ where: { id: outboxId }, data: { status: "sent", leaseToken: null, leaseUntil: null } });
    });
  }

  private async isAuthorized(
    document: { userId: string; consentEpoch: number; status: string; deletedAt: Date | null },
    requirements: readonly { purpose: string; grantEpoch: number }[],
    client: PrismaClient | Prisma.TransactionClient = this.database,
  ): Promise<boolean> {
    const [user, consent, privacy, epoch, killSwitch] = await Promise.all([
      client.user.findUnique({ where: { id: document.userId } }),
      client.consentRecord.findFirst({ where: { userId: document.userId, consentType: "health_processing" }, orderBy: { epoch: "desc" } }),
      client.privacyReconciliation.findUnique({ where: { id: "global" } }),
      client.safetyControlEpoch.findUnique({ where: { id: "global" } }),
      client.safetyControlRevision.findFirst({
        where: { controlType: "kill_switch", controlKey: "labs.ingestion", scopeType: "global", scopeId: "*" },
        orderBy: { version: "desc" },
      }),
    ]);
    const requirement = requirements.find((item) => item.purpose === "health_processing");
    return Boolean(
      user && user.status === "active" && !user.deletedAt &&
      consent?.granted && consent.epoch === user.consentEpoch && consent.epoch === document.consentEpoch &&
      requirement?.grantEpoch === document.consentEpoch && privacy?.status === "ready" &&
      epoch && !killSwitch?.active && document.status === "active" && !document.deletedAt,
    );
  }

  private async suppress(outboxId: string, leaseToken: string, documentId: string): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await tx.domainOutbox.updateMany({
        where: { id: outboxId, status: "leased", leaseToken },
        data: { status: "suppressed", leaseToken: null, leaseUntil: null },
      });
      await tx.labDocument.updateMany({
        where: { id: documentId, status: { not: "deleted" } },
        data: { status: "suppressed", failureCode: "authorization_changed" },
      });
    });
  }

  private async fail(outboxId: string, leaseToken: string, documentId: string, failureCode: string): Promise<void> {
    const message = await this.database.domainOutbox.findUnique({
      where: { id: outboxId }, include: { consentRequirements: true },
    });
    const document = await this.database.labDocument.findUnique({ where: { id: documentId } });
    if (!message || !document || !await this.isAuthorized(document, message.consentRequirements)) {
      await this.suppress(outboxId, leaseToken, documentId);
      return;
    }
    await this.database.$transaction(async (tx) => {
      await tx.domainOutbox.updateMany({
        where: { id: outboxId, status: "leased", leaseToken },
        data: { status: "failed", leaseToken: null, leaseUntil: null },
      });
      await tx.labDocument.updateMany({
        where: { id: documentId, status: "active" },
        data: { status: "failed", failureCode },
      });
    });
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ParserTimeoutError("Lab parser timed out")), this.config.timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private failureCode(error: unknown): string {
    if (error instanceof ParserTimeoutError) return "parser_timeout";
    if (error instanceof LabProviderUnavailableError) return "provider_unconfigured";
    if (error instanceof ProviderOutputError) return "provider_output_invalid";
    return "parser_failed";
  }

  private documentId(value: Prisma.JsonValue, aggregateId: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.document_id !== aggregateId) {
      throw new ProviderOutputError("Lab parse message identity is invalid");
    }
    return aggregateId;
  }

  private assertLease(message: { status: string; leaseToken: string | null; leaseUntil: Date | null }, token: string): void {
    if (message.status !== "leased" || message.leaseToken !== token || !message.leaseUntil || message.leaseUntil <= new Date()) {
      throw new Error("Lab parse lease is stale");
    }
  }
}
