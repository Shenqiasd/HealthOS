import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PrivacyControlStore } from "@healthos/contracts";

import type { DatabaseService } from "../database/prisma.service";
import { hmacSha256Hex, sha256Hex } from "../identity/crypto";

export interface PrivacyConfig {
  enabled?: boolean;
  tombstoneHashKey: string;
  tombstoneHashKeyVersion: string;
  deletionStatusTokenKey: string;
}

export class PrivacyService {
  private readonly enabled: boolean;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: PrivacyConfig,
    private readonly privacyControl: Pick<PrivacyControlStore, "beginDeletionFence">,
  ) {
    if (config.tombstoneHashKey.length < 32) {
      throw new Error("Tombstone hash key must contain at least 32 characters");
    }
    if (config.deletionStatusTokenKey.length < 32) {
      throw new Error("Deletion status token key must contain at least 32 characters");
    }
    this.enabled = config.enabled ?? true;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException("Privacy service is not configured");
    }
  }

  private userLookupHash(userId: string): string {
    return hmacSha256Hex(this.config.tombstoneHashKey, `deleted-user:${userId}`);
  }

  async requestExport(userId: string, idempotencyKey: string) {
    this.assertEnabled();
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
      return tx.exportJob.upsert({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        create: {
          userId,
          idempotencyKey,
          requestHash: sha256Hex("healthos-export-v1"),
        },
        update: {},
      });
    });
  }

  async getExport(userId: string, exportId: string) {
    this.assertEnabled();
    const job = await this.database.exportJob.findUnique({
      where: { id: exportId },
    });
    if (!job || job.userId !== userId) throw new NotFoundException("Export not found");
    return job;
  }

  async requestDeletion(
    userId: string,
    idempotencyKey: string,
    correlationId: string,
  ) {
    this.assertEnabled();
    const lookupHash = this.userLookupHash(userId);
    const requestedJobId = randomUUID();
    const fence = await this.privacyControl.beginDeletionFence({
      user_lookup_hash: lookupHash,
      hash_key_version: this.config.tombstoneHashKeyVersion,
      deletion_job_id: requestedJobId,
    });
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}::uuid
        FOR UPDATE
      `;
      const existing = await tx.deletionJob.findUnique({
        where: { userLookupHash: lookupHash },
      });
      if (existing) {
        return {
          job: existing,
          statusToken: this.deletionStatusToken(existing.id),
        };
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException("User not found");
      if (user.status !== "active") {
        throw new ConflictException("User processing is already frozen");
      }

      const requested = await tx.deletionJob.create({
        data: {
          userId,
          userLookupHash: lookupHash,
          hashKeyVersion: this.config.tombstoneHashKeyVersion,
          idempotencyKey,
          statusTokenHash: sha256Hex(this.deletionStatusToken(fence.deletion_job_id)),
          id: fence.deletion_job_id,
          status: "requested",
        },
      });
      const frozenAt = new Date();
      await tx.user.update({
        where: { id: userId },
        data: { status: "deleting", deletedAt: frozenAt },
      });
      await tx.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: frozenAt },
      });
      await tx.channelOutbox.updateMany({
        where: { userId, status: { in: ["pending", "leased"] } },
        data: { status: "suppressed" },
      });
      await tx.domainOutbox.updateMany({
        where: { userId, status: { in: ["pending", "leased"] } },
        data: { status: "suppressed" },
      });
      await tx.securityEvent.create({
        data: {
          userId,
          eventType: "privacy_deletion_frozen",
          severity: "high",
          correlationId,
          metadata: { deletion_job_id: requested.id },
        },
      });
      const job = await tx.deletionJob.update({
        where: { id: requested.id },
        data: { status: "frozen" },
      });
      return { job, statusToken: this.deletionStatusToken(job.id) };
    });
  }

  async getDeletionByStatusToken(deletionId: string, statusToken: string) {
    this.assertEnabled();
    const job = await this.database.deletionJob.findUnique({
      where: { id: deletionId },
    });
    const providedHash = Buffer.from(sha256Hex(statusToken), "hex");
    const storedHash = job ? Buffer.from(job.statusTokenHash, "hex") : Buffer.alloc(32);
    if (!job || !timingSafeEqual(storedHash, providedHash)) {
      throw new NotFoundException("Deletion request not found");
    }
    return job;
  }

  private deletionStatusToken(deletionJobId: string): string {
    return hmacSha256Hex(
      this.config.deletionStatusTokenKey,
      `deletion-status:${deletionJobId}`,
    );
  }
}
