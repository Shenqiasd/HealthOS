import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { TodayController } from "./today.controller";
import { TodayService } from "./today.service";

@Module({
  imports: [IdentityModule],
  controllers: [TodayController],
  providers: [
    {
      provide: TodayService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new TodayService(database),
    },
  ],
  exports: [TodayService],
})
export class TodayModule {}
