import { Module } from "@nestjs/common";

import { AdminAccessGuard } from "../admin/admin-access.guard";
import { AdminModule } from "../admin/admin.module";
import { DatabaseModule } from "../database/database.module";
import { SafetyControlsController } from "./safety-controls.controller";
import { SafetyControlsService } from "./safety-controls.service";

@Module({
  imports: [DatabaseModule, AdminModule],
  controllers: [SafetyControlsController],
  providers: [AdminAccessGuard, SafetyControlsService],
  exports: [SafetyControlsService],
})
export class KillSwitchesModule {}
