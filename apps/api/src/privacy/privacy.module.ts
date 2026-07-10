import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";

import { DatabaseService } from "../database/prisma.service";
import { IdentityModule } from "../identity/identity.module";
import { FilePrivacyControlStore } from "./file-privacy-control.store";
import { PrivacyController } from "./privacy.controller";
import { PrivacyService } from "./privacy.service";

function disabledSecret(): string {
  return randomBytes(32).toString("base64url");
}

@Module({
  imports: [IdentityModule],
  controllers: [PrivacyController],
  providers: [
    {
      provide: PrivacyService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const enabled = Boolean(
          process.env.PRIVACY_CONTROL_PATH &&
          process.env.DELETION_TOMBSTONE_HASH_KEY &&
          process.env.DELETION_TOMBSTONE_HASH_KEY_VERSION &&
          process.env.DELETION_STATUS_TOKEN_KEY,
        );
        const control = new FilePrivacyControlStore(
          process.env.PRIVACY_CONTROL_PATH ?? "/healthos/privacy-control-disabled",
        );
        return new PrivacyService(database, {
          enabled,
          tombstoneHashKey:
            process.env.DELETION_TOMBSTONE_HASH_KEY ?? disabledSecret(),
          tombstoneHashKeyVersion:
            process.env.DELETION_TOMBSTONE_HASH_KEY_VERSION ?? "disabled",
          deletionStatusTokenKey:
            process.env.DELETION_STATUS_TOKEN_KEY ?? disabledSecret(),
        }, control);
      },
    },
  ],
})
export class PrivacyModule {}
