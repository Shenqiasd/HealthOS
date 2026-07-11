import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { HealthModule } from "./health/health.module";
import { IdentityModule } from "./identity/identity.module";
import { ConsentModule } from "./consent/consent.module";
import { PrivacyModule } from "./privacy/privacy.module";
import { ProfileModule } from "./profile/profile.module";
import { RecommendationsModule } from "./recommendations/recommendations.module";
import { TodayModule } from "./today/today.module";
import { ActionsModule } from "./actions/actions.module";
import { SignalsModule } from "./signals/signals.module";
import { ReviewsModule } from "./reviews/reviews.module";

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ConsentModule,
    PrivacyModule,
    HealthModule,
    ProfileModule,
    RecommendationsModule,
    TodayModule,
    ActionsModule,
    SignalsModule,
    ReviewsModule,
  ],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
