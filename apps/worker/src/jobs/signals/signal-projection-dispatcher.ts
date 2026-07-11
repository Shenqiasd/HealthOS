import { createHash, randomUUID } from "node:crypto";

import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";

import { PermanentSignalProjectionError, type SignalProjectionWorker } from "./signal-projection-worker";

export interface SignalProjectionDispatcherConfig {
  leaseSeconds: number;
  pollMilliseconds: number;
}

export class SignalProjectionDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer = "signal-snapshot-projector-v1";
  private readonly logger = new Logger(SignalProjectionDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private activeDrain: Promise<boolean> | null = null;

  constructor(
    private readonly database: PrismaClient,
    private readonly projector: SignalProjectionWorker,
    private readonly config: SignalProjectionDispatcherConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test" || !process.env.DATABASE_URL) return;
    this.timer = setInterval(() => { this.scheduleDrain(); }, this.config.pollMilliseconds);
    this.timer.unref();
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.activeDrain) return;
    const active = this.drainOnce().catch(() => {
      this.logger.error("Signal projection drain failed; the leased message was marked retryable");
      return false;
    });
    this.activeDrain = active;
    void active.finally(() => {
      if (this.activeDrain === active) this.activeDrain = null;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.activeDrain) await this.activeDrain;
  }

  async claim(outboxId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: outboxId,
        eventType: "recommendation.published",
        availableAt: { lte: now },
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "leased", leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: "leased",
        leaseToken,
        leaseUntil: new Date(now.getTime() + this.config.leaseSeconds * 1_000),
      },
    });
    if (claimed.count !== 1) throw new Error("Signal projection message is not claimable");
    return this.database.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  }

  async process(outboxId: string, leaseToken: string): Promise<void> {
    const observed = await this.database.domainOutbox.findUnique({ where: { id: outboxId } });
    if (!observed) throw new Error("Signal projection message not found");
    const priorInbox = await this.database.consumerInbox.findUnique({
      where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
    });
    if (priorInbox) return;
    this.assertLease(observed, leaseToken);
    const payload = this.snapshotId(observed.payload, observed.aggregateId);
    const rows = await this.projector.project(payload);
    const resultHash = createHash("sha256")
      .update(rows.map((row) => `${row.signalCode}:${row.revision}:${row.sourceHash}`).sort().join("|"))
      .digest("hex");
    await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "domain_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE`;
      const message = await tx.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
      const processed = await tx.consumerInbox.findUnique({
        where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
      });
      if (processed) return;
      this.assertLease(message, leaseToken);
      await tx.consumerInbox.create({ data: {
        consumer: this.consumer, messageId: outboxId, resultHash,
      } });
      await tx.domainOutbox.update({
        where: { id: outboxId }, data: { status: "sent", leaseToken: null, leaseUntil: null },
      });
    });
  }

  async drainOnce(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    let leaseToken: string | null = null;
    let outboxId: string | null = null;
    try {
      const candidate = await this.database.domainOutbox.findFirst({
        where: {
          eventType: "recommendation.published",
          availableAt: { lte: new Date() },
          OR: [
            { status: { in: ["pending", "failed"] } },
            { status: "leased", leaseUntil: { lt: new Date() } },
          ],
        },
        orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      });
      if (!candidate) return false;
      outboxId = candidate.id;
      const lease = await this.claim(candidate.id);
      leaseToken = lease.leaseToken;
      if (!leaseToken) throw new Error("Signal projection lease token is missing");
      await this.process(candidate.id, leaseToken);
      return true;
    } catch (error) {
      const permanent = error instanceof PermanentSignalProjectionError;
      if (outboxId && leaseToken) {
        await this.database.domainOutbox.updateMany({
          where: { id: outboxId, status: "leased", leaseToken },
          data: { status: permanent ? "suppressed" : "failed", leaseToken: null, leaseUntil: null },
        });
      }
      if (permanent) return true;
      throw error;
    } finally {
      this.draining = false;
    }
  }

  private snapshotId(value: Prisma.JsonValue, aggregateId: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Signal projection payload is invalid");
    }
    const id = value.recommendation_snapshot_id;
    if (typeof id !== "string" || id !== aggregateId) {
      throw new Error("Signal projection snapshot identity is invalid");
    }
    return id;
  }

  private assertLease(message: { status: string; leaseToken: string | null; leaseUntil: Date | null }, token: string): void {
    if (message.status !== "leased" || message.leaseToken !== token || !message.leaseUntil || message.leaseUntil <= new Date()) {
      throw new Error("Signal projection lease is stale");
    }
  }
}
