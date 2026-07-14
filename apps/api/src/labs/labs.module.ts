import path from "node:path";

import { Module } from "@nestjs/common";

import { AdminAccessGuard } from "../admin/admin-access.guard";
import { AdminModule } from "../admin/admin.module";
import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import {
  FailClosedLabObjectStore,
  LabObjectStore,
  SyntheticFixtureLabObjectStore,
} from "./lab-object-store";
import { LabsController, LabsReviewController } from "./labs.controller";
import { LabsService } from "./labs.service";

function syntheticLabsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.HEALTHOS_LABS_MODE === "synthetic";
}

@Module({
  imports: [IdentityModule, AdminModule],
  controllers: [LabsController, LabsReviewController],
  providers: [
    AdminAccessGuard,
    {
      provide: LabObjectStore,
      useFactory: () => syntheticLabsEnabled()
        ? new SyntheticFixtureLabObjectStore(
          process.env.HEALTHOS_LABS_FIXTURE_DIR ?? path.resolve(process.cwd(), "../../packages/test-fixtures/labs"),
        )
        : new FailClosedLabObjectStore(),
    },
    {
      provide: LabsService,
      inject: [DatabaseService, LabObjectStore],
      useFactory: (database: DatabaseService, objectStore: LabObjectStore) =>
        new LabsService(database, objectStore, syntheticLabsEnabled()),
    },
  ],
  exports: [LabsService],
})
export class LabsModule {}
