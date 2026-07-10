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
    const user = await this.database.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== "active") {
      throw new UnauthorizedException("User is inactive");
    }
    const tokenFields = input.apnsToken
      ? {
          apnsTokenEncrypted: this.cipher.encrypt(input.apnsToken),
          apnsTokenFingerprint: this.cipher.fingerprint(input.apnsToken),
        }
      : {};
    return this.database.device.upsert({
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
  }
}
