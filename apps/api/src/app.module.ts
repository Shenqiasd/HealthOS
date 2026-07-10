import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { IdentityModule } from "./identity/identity.module";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
