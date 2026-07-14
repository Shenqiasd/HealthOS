import { UnauthorizedException } from "@nestjs/common";

import type { DatabaseService } from "../database/prisma.service";
import { AesGcmCipher, deriveKey, hmacSha256Hex } from "./crypto";

export class DeviceTokenCipher extends AesGcmCipher {
  private readonly fingerprintKey: Buffer;

  constructor(masterKey: Buffer) {
    super(deriveKey(masterKey, "apns-token-encryption"));
    this.fingerprintKey = deriveKey(masterKey, "apns-token-fingerprint");
  }

  fingerprint(value: string): string {
    return hmacSha256Hex(this.fingerprintKey, value);
  }
}

export interface RegisterDeviceInput {
  deviceId: string;
  appVersion: string;
  apnsToken?: string;
}

export class DeviceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly cipher: DeviceTokenCipher,
  ) {}

  async register(userId: string, input: RegisterDeviceInput) {
    const tokenFields = input.apnsToken
      ? {
          apnsTokenEncrypted: this.cipher.encrypt(input.apnsToken),
          apnsTokenFingerprint: this.cipher.fingerprint(input.apnsToken),
        }
      : {};
    return this.database.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "users" WHERE "id" = ${userId}::uuid FOR SHARE
      `;
      if (users.length !== 1 || users[0]?.status !== "active") {
        throw new UnauthorizedException("User is inactive");
      }
      if (tokenFields.apnsTokenFingerprint) {
        await tx.$queryRaw`
          SELECT "healthos_claim_apns_token"(
            ${userId}::uuid,
            ${input.deviceId},
            ${tokenFields.apnsTokenEncrypted},
            ${tokenFields.apnsTokenFingerprint},
            ${input.appVersion}
          ) AS "ownership_epoch"
        `;
        return tx.device.findUniqueOrThrow({
          where: { userId_deviceId: { userId, deviceId: input.deviceId } },
        });
      }
      return tx.device.upsert({
        where: { userId_deviceId: { userId, deviceId: input.deviceId } },
        create: {
          userId,
          deviceId: input.deviceId,
          appVersion: input.appVersion,
          lastSeenAt: new Date(),
          ...tokenFields,
        },
        update: {
          appVersion: input.appVersion,
          lastSeenAt: new Date(),
          ...tokenFields,
        },
      });
    });
  }
}
