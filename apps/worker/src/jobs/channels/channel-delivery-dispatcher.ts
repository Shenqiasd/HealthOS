import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

import type { ChannelDeliveryWorker } from "./channel-delivery-worker";

export class ChannelDeliveryDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChannelDeliveryDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<number> | null = null;

  constructor(
    private readonly database: PrismaClient,
    private readonly worker: ChannelDeliveryWorker,
    private readonly config: { enabled: boolean; pollMilliseconds: number },
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled || process.env.NODE_ENV === "test" || !process.env.DATABASE_URL) return;
    this.timer = setInterval(() => this.schedule(), this.config.pollMilliseconds);
    this.timer.unref();
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active) await this.active;
  }

  async runOnce(now: Date = new Date()): Promise<number> {
    if (!this.config.enabled) return 0;
    await this.worker.reconcileExpiredLeases(now);
    await this.worker.enqueueDueSchedules(now);
    const outboxes = await this.database.channelOutbox.findMany({
      where: {
        channel: { in: ["apns", "wecom"] },
        status: "pending",
        availableAt: { lte: now },
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true },
    });
    let processed = 0;
    for (const outbox of outboxes) {
      const result = await this.worker.deliverOne(outbox.id, now);
      if (result !== "not_claimed") processed += 1;
    }
    return processed;
  }

  private schedule(): void {
    if (this.active) return;
    const running = this.runOnce().catch(() => {
      this.logger.error("Synthetic local channel delivery pass failed");
      return 0;
    });
    this.active = running;
    void running.finally(() => {
      if (this.active === running) this.active = null;
    });
  }
}
