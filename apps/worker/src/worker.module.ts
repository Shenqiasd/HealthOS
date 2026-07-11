import { Module } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { RecommendationWorker } from "./jobs/recommendations/recommendation-worker";
import { SignalProjectionWorker } from "./jobs/signals/signal-projection-worker";
import { SignalProjectionDispatcher } from "./jobs/signals/signal-projection-dispatcher";

@Module({
  providers: [
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
    {
      provide: RecommendationWorker,
      inject: [PrismaClient],
      useFactory: (database: PrismaClient) => new RecommendationWorker(database, {
        releaseStage: process.env.HEALTHOS_RELEASE_STAGE === "beta" ? "beta" : "alpha",
        normalSamplePercent: 20,
        llmEnabled: false,
        leaseSeconds: 300,
        reviewSlaSeconds: 1800,
      }),
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
  ],
  exports: [RecommendationWorker, SignalProjectionWorker, SignalProjectionDispatcher],
})
export class WorkerModule {}
