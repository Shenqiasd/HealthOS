import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { HealthModule } from "./health/health.module";
import { IdentityModule } from "./identity/identity.module";
import { ConsentModule } from "./consent/consent.module";
import { PrivacyModule } from "./privacy/privacy.module";

@Module({
  imports: [DatabaseModule, IdentityModule, ConsentModule, PrivacyModule, HealthModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
