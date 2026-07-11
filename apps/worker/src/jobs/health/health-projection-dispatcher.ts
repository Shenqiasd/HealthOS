import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { canonicalSha256 } from "../profile/canonical-json";

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
        availableAt: { lte: now },
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
    if (
      observed.status !== "leased" ||
      observed.leaseToken !== leaseToken ||
      !observed.leaseUntil || observed.leaseUntil <= new Date()
    ) {
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
      if (
        message.status !== "leased" ||
        message.leaseToken !== leaseToken ||
        !message.leaseUntil || message.leaseUntil <= new Date()
      ) {
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
      const sourcePayload = message.payload as Prisma.JsonObject;
      const revisionIds = sourcePayload.revision_ids;
      if (
        typeof sourcePayload.sync_run_id !== "string" ||
        typeof sourcePayload.server_sequence !== "string" ||
        !/^\d+$/.test(sourcePayload.server_sequence) ||
        !Array.isArray(revisionIds) ||
        revisionIds.some((id) => typeof id !== "string")
      ) {
        throw new Error("Health projection revision IDs are invalid");
      }
      const revisions = await tx.dailyHealthFactRevision.findMany({
        where: { userId: message.user.id, id: { in: revisionIds as string[] } },
        orderBy: [
          { serverSequence: { sort: "asc", nulls: "last" } },
          { localDate: "asc" },
          { metric: "asc" },
          { id: "asc" },
        ],
      });
      if (revisions.length !== revisionIds.length) {
        throw new Error("Health projection revisions are incomplete");
      }
      const profilePayload = {
        sync_run_id: sourcePayload.sync_run_id,
        server_sequence: sourcePayload.server_sequence,
        facts: revisions.map((revision) => ({
          revision_id: revision.id,
          local_date: revision.localDate.toISOString().slice(0, 10),
          metric: revision.metric,
          value: (revision.canonicalValueJson as Prisma.JsonObject).value,
          coverage: revision.coverage === null ? null : Number(revision.coverage),
          server_sequence: revision.serverSequence?.toString() ?? null,
        })),
      };
      const payloadHash = canonicalSha256({
        event_type: "daily_health_facts_accepted",
        source: "health_ingestion",
        payload: profilePayload,
        occurred_at: null,
      });
      const consentEpoch = message.consentRequirements.find(
        (requirement) => requirement.purpose === "health_processing",
      )?.grantEpoch;
      if (consentEpoch === undefined) {
        throw new Error("Health projection consent epoch is missing");
      }
      const existingEvent = await tx.profileEvent.findUnique({
        where: {
          userId_correlationId: {
            userId: message.user.id,
            correlationId: message.id,
          },
        },
      });
      if (existingEvent && existingEvent.payloadHash !== payloadHash) {
        throw new Error("Health profile event correlation conflict");
      }
      const profileEvent = existingEvent ?? await tx.profileEvent.create({
        data: {
          userId: message.user.id,
          consentEpoch,
          eventType: "daily_health_facts_accepted",
          source: "health_ingestion",
          payload: profilePayload as Prisma.InputJsonValue,
          payloadHash,
          correlationId: message.id,
        },
      });
      await tx.domainOutbox.upsert({
        where: { idempotencyKey: `profile.event.appended:${profileEvent.id}` },
        create: {
          userId: message.user.id,
          aggregateId: profileEvent.id,
          eventType: "profile.event.appended",
          idempotencyKey: `profile.event.appended:${profileEvent.id}`,
          payload: {
            profile_event_id: profileEvent.id,
            event_sequence: profileEvent.sequence.toString(),
          },
          consentRequirements: {
            create: message.consentRequirements.map((requirement) => ({
              purpose: requirement.purpose,
              grantEpoch: requirement.grantEpoch,
            })),
          },
        },
        update: {},
      });
      const resultHash = canonicalSha256(profilePayload);
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
