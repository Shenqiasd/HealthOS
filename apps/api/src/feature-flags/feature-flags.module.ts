import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { FeatureFlagsService } from "./feature-flags.service";

@Module({
  imports: [DatabaseModule],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
