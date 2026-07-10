import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { FilePrivacyControlStore } from "../privacy/file-privacy-control.store";

@Module({
  imports: [IdentityModule],
  controllers: [ConsentController],
  providers: [
    {
      provide: ConsentService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const gate = new FilePrivacyControlStore(
          process.env.PRIVACY_CONTROL_PATH ?? "/healthos/privacy-control-disabled",
        );
        return new ConsentService(database, gate);
      },
    },
  ],
})
export class ConsentModule {}
