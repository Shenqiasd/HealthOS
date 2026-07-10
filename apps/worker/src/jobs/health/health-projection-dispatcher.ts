import { createHash, randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

export interface HealthProjectionDispatcherConfig {
  leaseSeconds: number;
}

export class HealthProjectionDispatcher {
  private readonly consumer = "health-profile-projector-v1";

  constructor(
    private readonly database: PrismaClient,
    private readonly config: HealthProjectionDispatcherConfig,
  ) {}

  async claim(outboxId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: outboxId,
        eventType: "health.facts.accepted",
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "leased", leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: "leased",
        leaseToken,
        leaseUntil: new Date(now.getTime() + this.config.leaseSeconds * 1_000),
      },
    });
    if (claimed.count !== 1) throw new Error("Health projection message is not claimable");
    return this.database.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  }

  async process(outboxId: string, leaseToken: string): Promise<void> {
    const observed = await this.database.domainOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!observed) throw new Error("Health projection message not found");
    if (observed.status === "sent") {
      const processed = await this.database.consumerInbox.findUnique({
        where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
      });
      if (processed) return;
    }
    if (observed.status !== "leased" || observed.leaseToken !== leaseToken) {
      throw new Error("Health projection lease is stale");
    }

    await this.database.$transaction(async (tx) => {
      if (observed.userId) {
        await tx.$queryRaw`
          SELECT "id"
          FROM "users"
          WHERE "id" = ${observed.userId}::uuid
          FOR UPDATE
        `;
      }
      await tx.$queryRaw`
        SELECT "id"
        FROM "domain_outbox"
        WHERE "id" = ${outboxId}::uuid
        FOR UPDATE
      `;
      const message = await tx.domainOutbox.findUniqueOrThrow({
        where: { id: outboxId },
        include: {
          consentRequirements: true,
          user: { include: { consents: true } },
        },
      });
      const processed = await tx.consumerInbox.findUnique({
        where: {
          consumer_messageId: {
            consumer: this.consumer,
            messageId: message.id,
          },
        },
      });
      if (processed) {
        await tx.domainOutbox.update({
          where: { id: message.id },
          data: { status: "sent", leaseToken: null, leaseUntil: null },
        });
        return;
      }
      if (message.status !== "leased" || message.leaseToken !== leaseToken) {
        throw new Error("Health projection lease is stale");
      }
      if (!message.user || !this.isAuthorized(
        message.user.status,
        message.user.consents,
        message.consentRequirements,
      )) {
        await tx.domainOutbox.update({
          where: { id: message.id },
          data: { status: "suppressed", leaseToken: null, leaseUntil: null },
        });
        return;
      }
      if (message.payload === null) throw new Error("Health projection payload is missing");
      await tx.profileEvent.create({
        data: {
          userId: message.user.id,
          eventType: "daily_health_facts_accepted",
          source: "health_ingestion",
          payload: message.payload as Prisma.InputJsonValue,
          correlationId: message.id,
        },
      });
      const resultHash = createHash("sha256")
        .update(JSON.stringify(message.payload))
        .digest("hex");
      await tx.consumerInbox.create({
        data: {
          consumer: this.consumer,
          messageId: message.id,
          resultHash,
        },
      });
      await tx.domainOutbox.update({
        where: { id: message.id },
        data: { status: "sent", leaseToken: null, leaseUntil: null },
      });
    });
  }

  private isAuthorized(
    userStatus: string,
    consents: ReadonlyArray<{ consentType: string; epoch: number; granted: boolean }>,
    requirements: ReadonlyArray<{ purpose: string; grantEpoch: number }>,
  ): boolean {
    if (userStatus !== "active" || requirements.length === 0) return false;
    return requirements.every((requirement) => {
      const latest = consents
        .filter((consent) => consent.consentType === requirement.purpose)
        .sort((left, right) => right.epoch - left.epoch)[0];
      return latest?.granted === true && latest.epoch === requirement.grantEpoch;
    });
  }
}
