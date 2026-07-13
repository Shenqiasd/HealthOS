import { Module } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { RecommendationWorker } from "./jobs/recommendations/recommendation-worker";
import { SignalProjectionWorker } from "./jobs/signals/signal-projection-worker";
import { SignalProjectionDispatcher } from "./jobs/signals/signal-projection-dispatcher";
import { WeeklyReviewDispatcher } from "./jobs/reviews/weekly-review-dispatcher";
import { WeeklyReviewWorker } from "./jobs/reviews/weekly-review-worker";
import { RespectfulScheduler } from "./jobs/scheduling/respectful-scheduler";
import { RespectfulSchedulerDispatcher } from "./jobs/scheduling/respectful-scheduler-dispatcher";
import { WorkerTelemetry } from "./telemetry/worker-telemetry";

@Module({
  providers: [
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
    { provide: WorkerTelemetry, useFactory: () => new WorkerTelemetry() },
    {
      provide: RecommendationWorker,
      inject: [PrismaClient, WorkerTelemetry],
      useFactory: (database: PrismaClient, telemetry: WorkerTelemetry) => new RecommendationWorker(database, {
        releaseStage: process.env.HEALTHOS_RELEASE_STAGE === "beta" ? "beta" : "alpha",
        normalSamplePercent: 20,
        llmEnabled: false,
        leaseSeconds: 300,
        reviewSlaSeconds: 1800,
      }, telemetry),
    },
    {
      provide: SignalProjectionWorker,
      inject: [PrismaClient],
      useFactory: (database: PrismaClient) => new SignalProjectionWorker(database),
    },
    {
      provide: SignalProjectionDispatcher,
      inject: [PrismaClient, SignalProjectionWorker],
      useFactory: (database: PrismaClient, projector: SignalProjectionWorker) =>
        new SignalProjectionDispatcher(database, projector, {
          leaseSeconds: 300,
          pollMilliseconds: 5_000,
        }),
    },
    {
      provide: WeeklyReviewWorker,
      inject: [PrismaClient],
      useFactory: (database: PrismaClient) => new WeeklyReviewWorker(database, {
        shareTtlSeconds: 7 * 24 * 60 * 60,
      }),
    },
    {
      provide: WeeklyReviewDispatcher,
      inject: [PrismaClient, WeeklyReviewWorker],
      useFactory: (database: PrismaClient, worker: WeeklyReviewWorker) =>
        new WeeklyReviewDispatcher(database, worker, { leaseSeconds: 300, pollMilliseconds: 5_000 }),
    },
    {
      provide: RespectfulScheduler,
      inject: [PrismaClient, WorkerTelemetry],
      useFactory: (database: PrismaClient, telemetry: WorkerTelemetry) => new RespectfulScheduler(database, undefined, telemetry),
    },
    {
      provide: RespectfulSchedulerDispatcher,
      inject: [RespectfulScheduler],
      useFactory: (scheduler: RespectfulScheduler) => new RespectfulSchedulerDispatcher(scheduler, 60_000),
    },
  ],
  exports: [
    RecommendationWorker,
    SignalProjectionWorker,
    SignalProjectionDispatcher,
    WeeklyReviewWorker,
    WeeklyReviewDispatcher,
    RespectfulScheduler,
    RespectfulSchedulerDispatcher,
    WorkerTelemetry,
  ],
})
export class WorkerModule {}
