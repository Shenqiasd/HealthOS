import { Module } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { RecommendationWorker } from "./jobs/recommendations/recommendation-worker";
import { ChannelDeliveryDispatcher } from "./jobs/channels/channel-delivery-dispatcher";
import { ChannelDeliveryWorker } from "./jobs/channels/channel-delivery-worker";
import { SyntheticLocalChannelProvider } from "./jobs/channels/local-channel-provider";
import { SignalProjectionWorker } from "./jobs/signals/signal-projection-worker";
import { SignalProjectionDispatcher } from "./jobs/signals/signal-projection-dispatcher";
import { WeeklyReviewDispatcher } from "./jobs/reviews/weekly-review-dispatcher";
import { WeeklyReviewWorker } from "./jobs/reviews/weekly-review-worker";
import { RespectfulScheduler } from "./jobs/scheduling/respectful-scheduler";
import { RespectfulSchedulerDispatcher } from "./jobs/scheduling/respectful-scheduler-dispatcher";
import { WorkerTelemetry } from "./telemetry/worker-telemetry";
import path from "node:path";
import { LabParsingDispatcher } from "./jobs/labs/lab-parsing-dispatcher";
import { LabParsingWorker } from "./jobs/labs/lab-parsing-worker";
import {
  FailClosedLabParserProvider,
  LabParserProvider,
  SyntheticFixtureLabParserProvider,
} from "./jobs/labs/lab-parser-provider";
import { FoodRiskDispatcher } from "./jobs/food/food-risk-dispatcher";
import { FoodRiskWorker } from "./jobs/food/food-risk-worker";
import {
  FailClosedFoodVisionProvider,
  FoodVisionProvider,
  SyntheticFixtureFoodVisionProvider,
} from "./jobs/food/food-vision-provider";

const syntheticChannelDeliveryEnabled = () =>
  process.env.NODE_ENV !== "production" && process.env.HEALTHOS_CHANNEL_MODE === "synthetic";

const syntheticLabsEnabled = () =>
  process.env.NODE_ENV !== "production" && process.env.HEALTHOS_LABS_MODE === "synthetic";

const syntheticFoodEnabled = () =>
  process.env.NODE_ENV !== "production" && process.env.HEALTHOS_FOOD_MODE === "synthetic";

@Module({
  providers: [
    { provide: PrismaClient, useFactory: () => new PrismaClient() },
    { provide: WorkerTelemetry, useFactory: () => new WorkerTelemetry() },
    { provide: SyntheticLocalChannelProvider, useFactory: () => new SyntheticLocalChannelProvider() },
    {
      provide: LabParserProvider,
      useFactory: () => syntheticLabsEnabled()
        ? new SyntheticFixtureLabParserProvider(
          process.env.HEALTHOS_LABS_FIXTURE_DIR ?? path.resolve(process.cwd(), "../../packages/test-fixtures/labs"),
        )
        : new FailClosedLabParserProvider(),
    },
    {
      provide: LabParsingWorker,
      inject: [PrismaClient, LabParserProvider],
      useFactory: (database: PrismaClient, provider: LabParserProvider) =>
        new LabParsingWorker(database, provider, { leaseSeconds: 300, timeoutMilliseconds: 30_000 }),
    },
    {
      provide: LabParsingDispatcher,
      inject: [PrismaClient, LabParsingWorker],
      useFactory: (database: PrismaClient, worker: LabParsingWorker) =>
        new LabParsingDispatcher(database, worker, { enabled: syntheticLabsEnabled(), pollMilliseconds: 5_000 }),
    },
    {
      provide: FoodVisionProvider,
      useFactory: () => syntheticFoodEnabled()
        ? new SyntheticFixtureFoodVisionProvider(
          process.env.HEALTHOS_FOOD_FIXTURE_DIR ?? path.resolve(process.cwd(), "../../packages/test-fixtures/food"),
        )
        : new FailClosedFoodVisionProvider(),
    },
    {
      provide: FoodRiskWorker,
      inject: [PrismaClient, FoodVisionProvider],
      useFactory: (database: PrismaClient, provider: FoodVisionProvider) =>
        new FoodRiskWorker(database, provider, { leaseSeconds: 300, timeoutMilliseconds: 30_000 }),
    },
    {
      provide: FoodRiskDispatcher,
      inject: [PrismaClient, FoodRiskWorker],
      useFactory: (database: PrismaClient, worker: FoodRiskWorker) =>
        new FoodRiskDispatcher(database, worker, { enabled: syntheticFoodEnabled(), pollMilliseconds: 5_000 }),
    },
    {
      provide: ChannelDeliveryWorker,
      inject: [PrismaClient, SyntheticLocalChannelProvider],
      useFactory: (database: PrismaClient, provider: SyntheticLocalChannelProvider) =>
        new ChannelDeliveryWorker(
          database,
          { apns: provider, wecom: provider },
          { enabled: syntheticChannelDeliveryEnabled() },
        ),
    },
    {
      provide: ChannelDeliveryDispatcher,
      inject: [PrismaClient, ChannelDeliveryWorker],
      useFactory: (database: PrismaClient, worker: ChannelDeliveryWorker) =>
        new ChannelDeliveryDispatcher(database, worker, {
          enabled: syntheticChannelDeliveryEnabled(),
          pollMilliseconds: 5_000,
        }),
    },
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
    ChannelDeliveryWorker,
    ChannelDeliveryDispatcher,
    SignalProjectionWorker,
    SignalProjectionDispatcher,
    WeeklyReviewWorker,
    WeeklyReviewDispatcher,
    RespectfulScheduler,
    RespectfulSchedulerDispatcher,
    WorkerTelemetry,
    LabParsingWorker,
    LabParsingDispatcher,
    FoodRiskWorker,
    FoodRiskDispatcher,
  ],
})
export class WorkerModule {}
