import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { IdentityModule } from "../identity/identity.module";
import { RemindersController } from "./reminders.controller";
import { RemindersService } from "./reminders.service";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
