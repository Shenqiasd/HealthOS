import { Module } from "@nestjs/common";

import { CoachProvider, LocalSyntheticCoachProvider } from "../ai/coach-provider";
import { DatabaseService } from "../database/prisma.service";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { IdentityModule } from "../identity/identity.module";
import { ProfileCandidateService } from "../profile/profile-candidate.service";
import { ProfileModule } from "../profile/profile.module";
import { CoachController } from "./coach.controller";
import { CoachService } from "./coach.service";

@Module({
  imports: [IdentityModule, FeatureFlagsModule, ProfileModule],
  controllers: [CoachController],
  providers: [
    { provide: CoachProvider, useClass: LocalSyntheticCoachProvider },
    {
      provide: CoachService,
      inject: [DatabaseService, FeatureFlagsService, CoachProvider, ProfileCandidateService],
      useFactory: (
        database: DatabaseService,
        flags: FeatureFlagsService,
        provider: CoachProvider,
        candidates: ProfileCandidateService,
      ) => new CoachService(database, flags, provider, candidates),
    },
  ],
  exports: [CoachService],
})
export class CoachModule {}
