import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";

import type { DatabaseService } from "../database/prisma.service";
import { sha256Hex } from "../identity/crypto";

export const CONSENT_PURPOSES = [
  "privacy_terms",
  "health_processing",
  "notifications",
  "external_ai",
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export interface RecordConsentInput {
  purpose: ConsentPurpose;
  documentVersion: string;
  granted: boolean;
  source: string;
  correlationId: string;
}

export interface ExternalSendGate {
  isSendAllowed(): Promise<boolean>;
}

type SendAuthorizationOutcome<T> =
  | { kind: "authorized"; result: T }
  | { kind: "rejected"; reason: string };

export class ConsentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly externalSendGate: ExternalSendGate,
  ) {}

  async record(userId: string, input: RecordConsentInput) {
    if (!CONSENT_PURPOSES.includes(input.purpose)) {
      throw new ConflictException("Unknown consent purpose");
    }
    const requestHash = sha256Hex(JSON.stringify([
      input.purpose,
      input.documentVersion,
      input.granted,
      input.source,
    ]));
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}::uuid
        FOR UPDATE
      `;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== "active") {
        throw new ForbiddenException("User processing is frozen");
      }
      const existing = await tx.consentRecord.findUnique({
        where: {
          userId_correlationId: {
            userId,
            correlationId: input.correlationId,
          },
        },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException("Consent idempotency key was reused");
        }
        return existing;
      }
      const epoch = user.consentEpoch + 1;
      const record = await tx.consentRecord.create({
        data: {
          userId,
          consentType: input.purpose,
          documentVersion: input.documentVersion,
          granted: input.granted,
          epoch,
          source: input.source,
          correlationId: input.correlationId,
          requestHash,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { consentEpoch: epoch },
      });
      if (!input.granted) {
        await tx.channelOutbox.updateMany({
          where: {
            userId,
            consentRequirements: { some: { purpose: input.purpose } },
            status: { in: ["pending", "leased"] },
          },
          data: { status: "suppressed" },
        });
        await tx.domainOutbox.updateMany({
          where: {
            userId,
            consentRequirements: { some: { purpose: input.purpose } },
            status: { in: ["pending", "leased"] },
          },
          data: { status: "suppressed" },
        });
      }
      return record;
    });
  }

  async current(userId: string) {
    const user = await this.database.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    const records = await this.database.consentRecord.findMany({
      where: { userId },
      orderBy: { epoch: "desc" },
    });
    const purposes: Record<string, {
      granted: boolean;
      documentVersion: string;
      epoch: number;
      recordedAt: Date;
    }> = {};
    for (const record of records) {
      if (purposes[record.consentType]) continue;
      purposes[record.consentType] = {
        granted: record.granted,
        documentVersion: record.documentVersion,
        epoch: record.epoch,
        recordedAt: record.recordedAt,
      };
    }
    return { consentEpoch: user.consentEpoch, purposes };
  }

  async invokeAuthorizedProvider<T>(
    outboxId: string,
    invoke: (authorization: { userId: string; consentEpoch: number }) => Promise<T>,
  ): Promise<T> {
    if (!(await this.externalSendGate.isSendAllowed())) {
      await this.suppressOutbox(outboxId);
      throw new ConflictException("External no-send gate blocks send");
    }
    const outcome = await this.database.$transaction<SendAuthorizationOutcome<T>>(
      async (tx) => {
        const outbox = await tx.channelOutbox.findUnique({
          where: { id: outboxId },
          include: { consentRequirements: true },
        });
        if (!outbox) throw new NotFoundException("Outbox message not found");

        await tx.$queryRaw`
          SELECT "id"
          FROM "users"
          WHERE "id" = ${outbox.userId}::uuid
          FOR UPDATE
        `;
        const reconciliation = await tx.privacyReconciliation.findUnique({
          where: { id: "global" },
        });
        const externalSendAllowed = await this.externalSendGate.isSendAllowed();
        const user = await tx.user.findUnique({ where: { id: outbox.userId } });
        const latestByPurpose = new Map<string, { granted: boolean; epoch: number }>();
        for (const requirement of outbox.consentRequirements) {
          const latest = await tx.consentRecord.findFirst({
            where: {
              userId: outbox.userId,
              consentType: requirement.purpose,
            },
            orderBy: { epoch: "desc" },
          });
          if (latest) {
            latestByPurpose.set(requirement.purpose, {
              granted: latest.granted,
              epoch: latest.epoch,
            });
          }
        }
        const allRequirementsCurrent = outbox.consentRequirements.length > 0 &&
          outbox.consentRequirements.every((requirement) => {
            const latest = latestByPurpose.get(requirement.purpose);
            return latest?.granted === true && latest.epoch === requirement.grantEpoch;
          });

        const rejection = !externalSendAllowed
          ? "External no-send gate blocks send"
          : reconciliation?.status !== "ready"
          ? "Privacy reconciliation blocks send"
          : !user || user.status !== "active"
            ? "User processing is frozen"
            : outbox.status !== "pending" && outbox.status !== "leased"
              ? "Outbox message is not sendable"
              : outbox.consentRequirements.length === 0
                ? "Outbox consent requirements are missing"
                : !allRequirementsCurrent
                  ? "Current consent does not authorize send"
                  : null;

        if (rejection) {
          if (outbox.status === "pending" || outbox.status === "leased") {
            await tx.channelOutbox.update({
              where: { id: outbox.id },
              data: { status: "suppressed" },
            });
          }
          return { kind: "rejected", reason: rejection };
        }
        const authorization = {
          userId: outbox.userId,
          consentEpoch: user!.consentEpoch,
        };
        return { kind: "authorized", result: await invoke(authorization) };
      },
    );

    if (outcome.kind === "rejected") {
      throw new ConflictException(outcome.reason);
    }
    return outcome.result;
  }

  private async suppressOutbox(outboxId: string): Promise<void> {
    await this.database.channelOutbox.updateMany({
      where: { id: outboxId, status: { in: ["pending", "leased"] } },
      data: { status: "suppressed" },
    });
  }
}
