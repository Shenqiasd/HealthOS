import { Module } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { RecommendationWorker } from "./jobs/recommendations/recommendation-worker";

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
  ],
  exports: [RecommendationWorker],
})
export class WorkerModule {}
