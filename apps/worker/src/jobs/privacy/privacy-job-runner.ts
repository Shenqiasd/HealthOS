import { createHmac, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import type { PrivacyControlStore } from "@healthos/contracts";

export interface PrivacyJobRunnerConfig {
  tombstoneHashKeys: Readonly<Record<string, string>>;
  leaseSeconds?: number;
}

export class PrivacyJobRunner {
  private readonly leaseSeconds: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly config: PrivacyJobRunnerConfig,
    private readonly privacyControl: PrivacyControlStore,
  ) {
    if (Object.values(config.tombstoneHashKeys).some((key) => key.length < 32)) {
      throw new Error("Every tombstone hash key must contain at least 32 characters");
    }
    this.leaseSeconds = config.leaseSeconds ?? 300;
  }

  async startExport(jobId: string) {
    const leaseToken = randomUUID();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1_000);
    const claimed = await this.database.exportJob.updateMany({
      where: {
        id: jobId,
        OR: [
          { status: { in: ["requested", "failed_retryable"] } },
          { status: "generating", leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: "generating",
        attempt: { increment: 1 },
        leaseToken,
        leaseUntil,
        errorCode: null,
      },
    });
    if (claimed.count !== 1) throw new Error("Export job is not claimable");
    return this.database.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async completeExport(
    jobId: string,
    leaseToken: string,
    objectKey: string,
    artifactSha256: string,
    expiresAt: Date,
  ) {
    if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
      throw new Error("Export artifact SHA-256 is invalid");
    }
    if (expiresAt <= new Date()) throw new Error("Export expiry must be in the future");
    const completed = await this.database.exportJob.updateMany({
      where: { id: jobId, status: "generating", leaseToken },
      data: {
        status: "ready",
        objectKey,
        artifactSha256,
        expiresAt,
        leaseToken: null,
        leaseUntil: null,
        errorCode: null,
      },
    });
    if (completed.count !== 1) throw new Error("Export lease is stale");
    return this.database.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async failExport(jobId: string, leaseToken: string, errorCode: string) {
    const failed = await this.database.exportJob.updateMany({
      where: { id: jobId, status: "generating", leaseToken },
      data: {
        status: "failed_retryable",
        errorCode,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    if (failed.count !== 1) throw new Error("Export lease is stale");
  }

  async expireExports(now: Date): Promise<number> {
    const expired = await this.database.exportJob.updateMany({
      where: { status: "ready", expiresAt: { lte: now } },
      data: { status: "expired" },
    });
    return expired.count;
  }

  async startDeletion(jobId: string) {
    const leaseToken = randomUUID();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1_000);
    const claimed = await this.database.deletionJob.updateMany({
      where: {
        id: jobId,
        OR: [
          { status: { in: ["frozen", "failed_retryable"] } },
          { status: "deleting", leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: "deleting",
        attempt: { increment: 1 },
        leaseToken,
        leaseUntil,
        errorCode: null,
      },
    });
    if (claimed.count !== 1) throw new Error("Deletion job is not claimable");
    return this.database.deletionJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async failDeletion(jobId: string, leaseToken: string, errorCode: string) {
    const failed = await this.database.deletionJob.updateMany({
      where: { id: jobId, status: "deleting", leaseToken },
      data: {
        status: "failed_retryable",
        errorCode,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    if (failed.count !== 1) throw new Error("Deletion lease is stale");
  }

  async completeDeletion(jobId: string, leaseToken: string) {
    const observed = await this.database.deletionJob.findUnique({
      where: { id: jobId },
    });
    if (!observed) throw new Error("Deletion job not found");
    if (observed.status === "completed") return observed;
    if (observed.status !== "deleting" || observed.leaseToken !== leaseToken) {
      throw new Error("Deletion lease is stale");
    }
    if (!observed.userId) throw new Error("Deletion job has no user");

    await this.privacyControl.completeDeletionFence(
      observed.userLookupHash,
      observed.id,
    );

    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "deletion_jobs"
        WHERE "id" = ${jobId}::uuid
        FOR UPDATE
      `;
      const current = await tx.deletionJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      if (current.status === "completed") return current;
      if (
        current.status !== "deleting" ||
        current.leaseToken !== leaseToken ||
        !current.userId
      ) {
        throw new Error("Deletion lease is stale");
      }
      await tx.$queryRaw`SELECT "healthos_delete_frozen_user"(${current.userId}::uuid)`;
      return tx.deletionJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          userId: null,
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          errorCode: null,
        },
      });
    });
  }

  async reconcileAfterRestore(restoreRunId: string, backupId: string) {
    await this.privacyControl.blockSends(restoreRunId);
    await this.database.privacyReconciliation.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        status: "running",
        restoreRunId,
        backupId,
        startedAt: new Date(),
      },
      update: {
        status: "running",
        restoreRunId,
        backupId,
        startedAt: new Date(),
        completedAt: null,
        errorCode: null,
      },
    });

    try {
      await this.deleteRestoredTombstonedUsers();
      await this.suppressInvalidChannelOutbox();
      await this.suppressInvalidDomainOutbox();
      await this.database.privacyReconciliation.update({
        where: { id: "global" },
        data: { status: "ready", completedAt: new Date() },
      });
      await this.privacyControl.allowSends(restoreRunId);
    } catch (error) {
      await this.database.privacyReconciliation.update({
        where: { id: "global" },
        data: {
          status: "failed",
          errorCode: error instanceof Error ? error.name : "UNKNOWN",
        },
      });
      throw error;
    }
  }

  private async deleteRestoredTombstonedUsers(): Promise<void> {
    const fences = await this.privacyControl.listCompletedDeletionFences();
    const users = await this.database.user.findMany({ select: { id: true } });
    for (const user of users) {
      const matched = fences.some((fence) => {
        const key = this.config.tombstoneHashKeys[fence.hash_key_version];
        if (!key) throw new Error("Unknown tombstone hash-key version");
        return this.lookupHash(key, user.id) === fence.user_lookup_hash;
      });
      if (!matched) continue;
      await this.database.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { status: "deleting", deletedAt: new Date() },
        });
        await tx.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
      });
    }
  }

  private async suppressInvalidChannelOutbox(): Promise<void> {
    const outboxes = await this.database.channelOutbox.findMany({
      where: { status: { in: ["pending", "leased"] } },
      include: { consentRequirements: true, user: { include: { consents: true } } },
    });
    for (const outbox of outboxes) {
      if (this.isAuthorized(outbox.user.status, outbox.user.consents, outbox.consentRequirements)) {
        continue;
      }
      await this.database.channelOutbox.update({
        where: { id: outbox.id },
        data: { status: "suppressed" },
      });
    }
  }

  private async suppressInvalidDomainOutbox(): Promise<void> {
    const outboxes = await this.database.domainOutbox.findMany({
      where: { userId: { not: null }, status: { in: ["pending", "leased"] } },
      include: { consentRequirements: true, user: { include: { consents: true } } },
    });
    for (const outbox of outboxes) {
      if (
        outbox.user &&
        this.isAuthorized(
          outbox.user.status,
          outbox.user.consents,
          outbox.consentRequirements,
        )
      ) {
        continue;
      }
      await this.database.domainOutbox.update({
        where: { id: outbox.id },
        data: { status: "suppressed" },
      });
    }
  }

  private isAuthorized(
    userStatus: string,
    consents: ReadonlyArray<{ consentType: string; epoch: number; granted: boolean }>,
    requirements: ReadonlyArray<{ purpose: string; grantEpoch: number }>,
  ): boolean {
    if (userStatus !== "active" || requirements.length === 0) return false;
    return requirements.every((requirement) => {
      const latest = consents
        .filter((consent) => consent.consentType === requirement.purpose)
        .sort((left, right) => right.epoch - left.epoch)[0];
      return latest?.granted === true && latest.epoch === requirement.grantEpoch;
    });
  }

  private lookupHash(key: string, userId: string): string {
    return createHmac("sha256", key)
      .update(`deleted-user:${userId}`, "utf8")
      .digest("hex");
  }
}
