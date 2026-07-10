import { ConflictException, ForbiddenException } from "@nestjs/common";

import type { DatabaseService } from "../database/prisma.service";
import { sha256Hex } from "../identity/crypto";
import { DailyFactProjector } from "./daily-fact-projector";
import {
  canonicalHealthBatch,
  type HealthSyncBatchInput,
  validateHealthBatch,
} from "./health-types";

export interface HealthIngestionResult {
  syncRunId: string;
  serverSequence: bigint;
  createdRevisionIds: string[];
}

export class HealthIngestionService {
  private readonly projector = new DailyFactProjector();

  constructor(private readonly database: DatabaseService) {}

  async ingest(
    userId: string,
    correlationId: string,
    input: HealthSyncBatchInput,
  ): Promise<HealthIngestionResult> {
    validateHealthBatch(input);
    const canonical = canonicalHealthBatch(input);
    const requestHash = sha256Hex(JSON.stringify(canonical));

    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}::uuid
        FOR UPDATE
      `;
      const existing = await tx.healthSyncRun.findUnique({
        where: {
          userId_idempotencyKey: {
            userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: { factRevisions: true },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException("Health sync idempotency key was reused");
        }
        return {
          syncRunId: existing.id,
          serverSequence: existing.serverSequence,
          createdRevisionIds: existing.factRevisions.map((revision) => revision.id),
        };
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== "active") {
        throw new ForbiddenException("User health processing is frozen");
      }
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" },
        orderBy: { epoch: "desc" },
      });
      if (!consent?.granted) {
        throw new ForbiddenException("Health processing consent is required");
      }
      const device = await tx.device.findUnique({
        where: { userId_deviceId: { userId, deviceId: input.deviceId } },
      });
      if (!device?.isPrimaryHealthDevice) {
        throw new ForbiddenException("Only the primary health device may upload");
      }
      const previousRun = await tx.healthSyncRun.findFirst({
        where: { userId, deviceId: input.deviceId, status: "completed" },
        orderBy: { serverSequence: "desc" },
      });
      if (previousRun && input.anchorEpoch < previousRun.anchorEpoch) {
        throw new ConflictException("Health anchor epoch cannot move backwards");
      }

      const run = await tx.healthSyncRun.create({
        data: {
          userId,
          deviceId: input.deviceId,
          anchorEpoch: input.anchorEpoch,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          timezone: input.timezone,
          consentEpoch: consent.epoch,
          status: "pending",
          correlationId,
        },
      });
      const createdRevisionIds: string[] = [];
      for (const fact of canonical.facts) {
        const revisionId = await this.projector.project(tx, {
          userId,
          syncRunId: run.id,
          serverSequence: run.serverSequence,
          fact,
        });
        if (revisionId) createdRevisionIds.push(revisionId);
      }
      if (createdRevisionIds.length > 0) {
        await tx.domainOutbox.create({
          data: {
            userId,
            eventType: "health.facts.accepted",
            aggregateId: run.id,
            payload: {
              sync_run_id: run.id,
              revision_ids: createdRevisionIds,
              server_sequence: run.serverSequence.toString(),
            },
            idempotencyKey: `health.facts.accepted:${run.id}`,
            consentRequirements: {
              create: {
                purpose: "health_processing",
                grantEpoch: consent.epoch,
              },
            },
          },
        });
      }
      if (previousRun && input.anchorEpoch > previousRun.anchorEpoch) {
        await tx.domainOutbox.create({
          data: {
            userId,
            eventType: "health.reconciliation.requested",
            aggregateId: run.id,
            payload: {
              sync_run_id: run.id,
              reason: "anchor_epoch_changed",
              window_days: 90,
            },
            idempotencyKey: `health.reconciliation.requested:${run.id}`,
            consentRequirements: {
              create: {
                purpose: "health_processing",
                grantEpoch: consent.epoch,
              },
            },
          },
        });
      }
      await tx.healthSyncRun.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date() },
      });
      return {
        syncRunId: run.id,
        serverSequence: run.serverSequence,
        createdRevisionIds,
      };
    });
  }
}
