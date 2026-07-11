import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { IdentityModule } from "../identity/identity.module";
import { ActionFeedbackService } from "./action-feedback.service";
import { ActionsController } from "./actions.controller";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [ActionsController],
  providers: [ActionFeedbackService],
  exports: [ActionFeedbackService],
})
export class ActionsModule {}
