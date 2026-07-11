import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { ProfileCandidateService } from "./profile-candidate.service";
import { ProfileController } from "./profile.controller";
import { ProfileEventService } from "./profile-event.service";
import { ProfileSnapshotService } from "./profile-snapshot.service";

@Module({
  imports: [IdentityModule],
  controllers: [ProfileController],
  providers: [
    {
      provide: ProfileEventService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new ProfileEventService(database),
    },
    {
      provide: ProfileCandidateService,
      inject: [DatabaseService, ProfileEventService],
      useFactory: (database: DatabaseService, events: ProfileEventService) =>
        new ProfileCandidateService(database, events),
    },
    {
      provide: ProfileSnapshotService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new ProfileSnapshotService(database),
    },
  ],
})
export class ProfileModule {}
