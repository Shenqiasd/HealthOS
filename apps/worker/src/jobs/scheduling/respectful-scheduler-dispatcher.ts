import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";

import type { RespectfulScheduler } from "./respectful-scheduler";

export class RespectfulSchedulerDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RespectfulSchedulerDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<number> | null = null;

  constructor(
    private readonly scheduler: RespectfulScheduler,
    private readonly pollMilliseconds: number,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test" || !process.env.DATABASE_URL) return;
    this.timer = setInterval(() => this.schedule(), this.pollMilliseconds);
    this.timer.unref();
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active) await this.active;
  }

  private schedule(): void {
    if (this.active) return;
    const running = this.scheduler.runDue(new Date()).catch(() => {
      this.logger.error("Respectful scheduler pass failed; no external delivery was attempted");
      return 0;
    });
    this.active = running;
    void running.finally(() => { if (this.active === running) this.active = null; });
  }
}
