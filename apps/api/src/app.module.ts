import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
