import { ForbiddenException, NotFoundException } from "@nestjs/common";

import type { DatabaseService } from "../database/prisma.service";

export class ProfileSnapshotService {
  constructor(private readonly database: DatabaseService) {}

  async current(userId: string) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}::uuid
        FOR SHARE
      `;
      const user = await tx.user.findUnique({ where: { id: userId } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" },
        orderBy: { epoch: "desc" },
      });
      if (!user || user.status !== "active" || !consent?.granted) {
        throw new ForbiddenException("Current health-processing consent is required");
      }
      const snapshot = await tx.profileSnapshot.findFirst({
        where: { userId, consentEpoch: consent.epoch },
        orderBy: { version: "desc" },
      });
      if (!snapshot) throw new NotFoundException("Profile snapshot not available");
      return snapshot;
    });
  }
}
