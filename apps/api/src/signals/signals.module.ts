import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { IdentityModule } from "../identity/identity.module";
import { SignalsController } from "./signals.controller";
import { SignalsService } from "./signals.service";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [SignalsController],
  providers: [SignalsService],
  exports: [SignalsService],
})
export class SignalsModule {}
