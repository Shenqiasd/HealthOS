import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import { createRemoteJWKSet } from "jose";

import { DatabaseService } from "../database/prisma.service";
import { AccessTokenGuard } from "./access-token.guard";
import { AppleTokenVerifier } from "./apple-token-verifier";
import { DeviceService, DeviceTokenCipher } from "./device.service";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";
import { SessionService } from "./session.service";

function hasIdentityConfiguration(): boolean {
  return Boolean(
    process.env.APPLE_CLIENT_ID &&
      process.env.SESSION_SIGNING_SECRET &&
      process.env.APPLE_SUBJECT_HASH_KEY &&
      process.env.DEVICE_TOKEN_ENCRYPTION_KEY,
  );
}

function disabledSecret(): string {
  return randomBytes(32).toString("base64url");
}

function deviceKey(enabled: boolean): Buffer {
  if (!enabled) return randomBytes(32);
  const key = Buffer.from(process.env.DEVICE_TOKEN_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) {
    throw new Error("DEVICE_TOKEN_ENCRYPTION_KEY must be 32 bytes in base64");
  }
  return key;
}

@Module({
  controllers: [IdentityController],
  providers: [
    {
      provide: AppleTokenVerifier,
      useFactory: () =>
        new AppleTokenVerifier({
          audience: process.env.APPLE_CLIENT_ID ?? "identity-disabled",
          keySet: createRemoteJWKSet(
            new URL("https://appleid.apple.com/auth/keys"),
          ),
        }),
    },
    {
      provide: SessionService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const enabled = hasIdentityConfiguration();
        return new SessionService(database, {
          enabled,
          issuer: "healthos",
          signingSecret: process.env.SESSION_SIGNING_SECRET ?? disabledSecret(),
          ...(process.env.SESSION_SIGNING_SECRET_PREVIOUS
            ? {
                previousSigningSecret:
                  process.env.SESSION_SIGNING_SECRET_PREVIOUS,
              }
            : {}),
          accessTtlSeconds: 900,
          refreshTtlSeconds: 30 * 24 * 60 * 60,
        });
      },
    },
    {
      provide: IdentityService,
      inject: [DatabaseService, AppleTokenVerifier, SessionService],
      useFactory: (
        database: DatabaseService,
        verifier: AppleTokenVerifier,
        sessions: SessionService,
      ) => {
        const enabled = hasIdentityConfiguration();
        return new IdentityService(database, verifier, sessions, {
          enabled,
          subjectHashKey: process.env.APPLE_SUBJECT_HASH_KEY ?? disabledSecret(),
          nonceTtlSeconds: 300,
        });
      },
    },
    {
      provide: DeviceTokenCipher,
      useFactory: () => {
        const enabled = hasIdentityConfiguration();
        return new DeviceTokenCipher(deviceKey(enabled));
      },
    },
    {
      provide: DeviceService,
      inject: [DatabaseService, DeviceTokenCipher],
      useFactory: (database: DatabaseService, cipher: DeviceTokenCipher) =>
        new DeviceService(database, cipher),
    },
    AccessTokenGuard,
  ],
})
export class IdentityModule {}
