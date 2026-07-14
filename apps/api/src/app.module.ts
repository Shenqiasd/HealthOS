import { Module } from "@nestjs/common";

import { ReadinessService } from "./common/readiness.service";
import { DatabaseModule } from "./database/database.module";
import { FeatureFlagsModule } from "./feature-flags/feature-flags.module";
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
import { AdminModule } from "./admin/admin.module";
import { RemindersModule } from "./reminders/reminders.module";
import { KillSwitchesModule } from "./kill-switches/kill-switches.module";
import { CoachModule } from "./coach/coach.module";
import { LabsModule } from "./labs/labs.module";
import { FoodModule } from "./food/food.module";

@Module({
  imports: [
    DatabaseModule,
    FeatureFlagsModule,
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
    AdminModule,
    RemindersModule,
    KillSwitchesModule,
    CoachModule,
    LabsModule,
    FoodModule,
  ],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class AppModule {}
