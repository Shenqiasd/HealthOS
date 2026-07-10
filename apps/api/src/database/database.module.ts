import { Global, Module } from "@nestjs/common";

import { DatabaseService } from "./prisma.service";
import { PublicationRepository } from "./publication.repository";

@Global()
@Module({
  providers: [DatabaseService, PublicationRepository],
  exports: [DatabaseService, PublicationRepository],
})
export class DatabaseModule {}
