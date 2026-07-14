import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

import type { LabParsingWorker } from "./lab-parsing-worker";

interface DispatcherConfig {
  enabled: boolean;
  pollMilliseconds: number;
}

export class LabParsingDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LabParsingDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<boolean> | null = null;

  constructor(
    private readonly database: PrismaClient,
    private readonly worker: LabParsingWorker,
    private readonly config: DispatcherConfig,
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

  async drainOnce(): Promise<boolean> {
    const candidate = await this.database.domainOutbox.findFirst({
      where: {
        eventType: "lab.document.ready",
        availableAt: { lte: new Date() },
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "leased", leaseUntil: { lt: new Date() } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    });
    if (!candidate) return false;
    const lease = await this.worker.claim(candidate.id);
    await this.worker.process(candidate.id, lease.leaseToken ?? "missing");
    return true;
  }

  private schedule(): void {
    if (this.active) return;
    const run = this.drainOnce().catch(() => {
      this.logger.error("Lab parsing drain failed; the lease remains recoverable");
      return false;
    });
    this.active = run;
    void run.finally(() => {
      if (this.active === run) this.active = null;
    });
  }
}
