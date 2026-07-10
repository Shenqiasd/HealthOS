import { Module } from "@nestjs/common";

import { RecommendationRunService } from "./recommendation-run.service";
import { RuleBundleService } from "./rule-bundle.service";

@Module({
  providers: [RecommendationRunService, RuleBundleService],
  exports: [RecommendationRunService, RuleBundleService],
})
export class RecommendationsModule {}
