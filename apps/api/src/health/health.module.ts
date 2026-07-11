import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { FreshnessService } from "./freshness.service";
import { HealthIngestionController } from "./health.controller";
import { HealthIngestionService } from "./health-ingestion.service";

@Module({
  imports: [IdentityModule],
  controllers: [HealthIngestionController],
  providers: [
    {
      provide: HealthIngestionService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new HealthIngestionService(database),
    },
    {
      provide: FreshnessService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new FreshnessService(database),
    },
  ],
})
export class HealthModule {}
