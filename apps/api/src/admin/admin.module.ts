import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { AdminAccessGuard } from "./admin-access.guard";
import { AdminController } from "./admin.controller";
import { AdminCursorCodec } from "./admin-cursor.codec";
import { AdminIdentityVerifier, DisabledAdminIdentityVerifier } from "./admin-identity.verifier";
import { AdminService } from "./admin.service";

const TEST_CURSOR_SIGNING_SECRET = "healthos-admin-cursor-test-secret-00000000000";

export function resolveAdminCursorSigningSecret(env: NodeJS.ProcessEnv): string {
  if (env.ADMIN_CURSOR_SIGNING_SECRET) return env.ADMIN_CURSOR_SIGNING_SECRET;
  if (env.NODE_ENV === "test") return TEST_CURSOR_SIGNING_SECRET;
  throw new Error("Admin cursor signing secret is required");
}

@Module({
  imports: [DatabaseModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminAccessGuard,
    {
      provide: AdminCursorCodec,
      useFactory: () => new AdminCursorCodec(resolveAdminCursorSigningSecret(process.env)),
    },
    { provide: AdminIdentityVerifier, useClass: DisabledAdminIdentityVerifier },
  ],
  exports: [AdminIdentityVerifier, AdminService],
})
export class AdminModule {}
