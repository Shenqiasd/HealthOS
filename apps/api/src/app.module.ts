import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
