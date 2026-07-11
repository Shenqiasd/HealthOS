import { createHash, randomUUID } from "node:crypto";

import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";

import { PermanentWeeklyReviewError, type WeeklyReviewWorker } from "./weekly-review-worker";

export class WeeklyReviewDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer = "weekly-review-projector-v1";
  private readonly logger = new Logger(WeeklyReviewDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private activeDrain: Promise<boolean> | null = null;

  constructor(
    private readonly database: PrismaClient,
    private readonly worker: WeeklyReviewWorker,
    private readonly config: { leaseSeconds: number; pollMilliseconds: number },
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test" || !process.env.DATABASE_URL) return;
    this.timer = setInterval(() => this.schedule(), this.config.pollMilliseconds);
    this.timer.unref();
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeDrain) await this.activeDrain;
  }

  private schedule(): void {
    if (this.activeDrain) return;
    const active = this.drainOnce().catch(() => {
      this.logger.error("Weekly review drain failed; the leased message was marked retryable");
      return false;
    });
    this.activeDrain = active;
    void active.finally(() => { if (this.activeDrain === active) this.activeDrain = null; });
  }

  async drainOnce(): Promise<boolean> {
    const candidate = await this.database.domainOutbox.findFirst({
      where: {
        eventType: "weekly_review.generate_requested",
        availableAt: { lte: new Date() },
        OR: [{ status: { in: ["pending", "failed"] } }, { status: "leased", leaseUntil: { lt: new Date() } }],
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    });
    if (!candidate) return false;
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: candidate.id,
        eventType: "weekly_review.generate_requested",
        OR: [{ status: { in: ["pending", "failed"] } }, { status: "leased", leaseUntil: { lt: new Date() } }],
      },
      data: {
        status: "leased", leaseToken,
        leaseUntil: new Date(Date.now() + this.config.leaseSeconds * 1_000),
      },
    });
    if (claimed.count !== 1) return false;
    try {
      const message = await this.database.domainOutbox.findUniqueOrThrow({ where: { id: candidate.id } });
      const payload = this.payload(message.payload, message.userId);
      const snapshot = await this.worker.project(payload);
      const resultHash = createHash("sha256").update(`${snapshot.id}:${snapshot.snapshotHash}`).digest("hex");
      await this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "domain_outbox" WHERE "id" = ${message.id}::uuid FOR UPDATE`;
        const current = await tx.domainOutbox.findUniqueOrThrow({ where: { id: message.id } });
        const processed = await tx.consumerInbox.findUnique({
          where: { consumer_messageId: { consumer: this.consumer, messageId: message.id } },
        });
        if (processed) return;
        if (current.status !== "leased" || current.leaseToken !== leaseToken ||
          !current.leaseUntil || current.leaseUntil <= new Date()) throw new Error("Weekly review lease is stale");
        await tx.consumerInbox.create({ data: { consumer: this.consumer, messageId: message.id, resultHash } });
        await tx.domainOutbox.update({
          where: { id: message.id }, data: { status: "sent", leaseToken: null, leaseUntil: null },
        });
      });
      return true;
    } catch (error) {
      const permanent = error instanceof PermanentWeeklyReviewError;
      await this.database.domainOutbox.updateMany({
        where: { id: candidate.id, status: "leased", leaseToken },
        data: { status: permanent ? "suppressed" : "failed", leaseToken: null, leaseUntil: null },
      });
      if (permanent) return true;
      throw error;
    }
  }

  private payload(value: Prisma.JsonValue, userId: string | null) {
    if (!userId || !value || typeof value !== "object" || Array.isArray(value)) {
      permanentPayload();
    }
    const weekStart = value.week_start;
    const cutoffAt = value.cutoff_at;
    const consentEpoch = value.consent_epoch;
    if (typeof weekStart !== "string" || typeof cutoffAt !== "string" ||
      typeof consentEpoch !== "number" || !Number.isInteger(consentEpoch)) permanentPayload();
    const parsedCutoff = new Date(cutoffAt);
    if (!Number.isFinite(parsedCutoff.getTime())) permanentPayload();
    return { userId, weekStart, cutoffAt: parsedCutoff, consentEpoch };
  }
}

function permanentPayload(): never {
  throw new PermanentWeeklyReviewError("Weekly review outbox payload is invalid");
}
