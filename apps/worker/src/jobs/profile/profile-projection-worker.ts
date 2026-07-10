import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient, ProfileEvent } from "@prisma/client";

import { canonicalSha256 } from "./canonical-json";

export interface ProfileProjectionWorkerConfig {
  leaseSeconds: number;
}

interface ProfileFacts {
  daily_health: Record<string, Record<string, Record<string, unknown>>>;
  labs: Record<string, Record<string, unknown>>;
  limitations: Record<string, { active: boolean }>;
}

const HEALTH_METRICS = new Set([
  "steps",
  "active_energy_kcal",
  "exercise_minutes",
  "sleep_minutes",
  "resting_heart_rate_bpm",
  "hrv_ms",
  "workout_minutes",
  "weight_kg",
  "vo2_max",
]);

export interface ReplayedProfileSnapshot {
  version: number;
  sourceEventId: string;
  sourceSequence: bigint;
  consentEpoch: number;
  factsJson: ProfileFacts;
  snapshotHash: string;
}

function emptyFacts(): ProfileFacts {
  return { daily_health: {}, labs: {}, limitations: {} };
}

function objectPayload(event: Pick<ProfileEvent, "payload">): Record<string, unknown> {
  if (event.payload === null || Array.isArray(event.payload) || typeof event.payload !== "object") {
    throw new Error("Profile event payload must be an object");
  }
  return event.payload as Record<string, unknown>;
}

function applyEvent(facts: ProfileFacts, event: ProfileEvent): void {
  const payload = objectPayload(event);
  if (event.eventType === "limitation_confirmed") {
    if (typeof payload.code !== "string" || typeof payload.active !== "boolean") {
      throw new Error("Limitation profile event is invalid");
    }
    if (payload.active) facts.limitations[payload.code] = { active: true };
    else delete facts.limitations[payload.code];
    return;
  }
  if (event.eventType === "lab_value_corrected") {
    if (
      typeof payload.field_code !== "string" ||
      typeof payload.unit !== "string" ||
      typeof payload.value !== "number" || !Number.isFinite(payload.value)
    ) {
      throw new Error("Corrected lab profile event is invalid");
    }
    facts.labs[payload.field_code] = {
      value: payload.value,
      unit: payload.unit,
      source_event_sequence: event.sequence.toString(),
    };
    return;
  }
  if (event.eventType === "daily_health_facts_accepted") {
    if (!Array.isArray(payload.facts)) {
      throw new Error("Daily health profile event is invalid");
    }
    for (const item of payload.facts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Daily health profile fact is invalid");
      }
      const fact = item as Record<string, unknown>;
      if (
        typeof fact.revision_id !== "string" ||
        typeof fact.local_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(fact.local_date) ||
        typeof fact.metric !== "string" || !HEALTH_METRICS.has(fact.metric) ||
        typeof fact.value !== "number" || !Number.isFinite(fact.value) ||
        typeof fact.coverage !== "number" || fact.coverage < 0 || fact.coverage > 1 ||
        typeof fact.server_sequence !== "string" || !/^\d+$/.test(fact.server_sequence)
      ) {
        throw new Error("Daily health profile fact identity is invalid");
      }
      const day = facts.daily_health[fact.local_date] ?? {};
      day[fact.metric] = {
        value: fact.value,
        coverage: fact.coverage,
        revision_id: fact.revision_id,
        server_sequence: fact.server_sequence,
      };
      facts.daily_health[fact.local_date] = day;
    }
    return;
  }
  throw new Error(`Unsupported profile event type: ${event.eventType}`);
}

export function replayProfileEvents(
  sourceEvents: readonly ProfileEvent[],
  baseVersion = 0,
): ReplayedProfileSnapshot[] {
  const ordered = [...sourceEvents].sort((left, right) => {
    if (left.sequence < right.sequence) return -1;
    if (left.sequence > right.sequence) return 1;
    return left.id.localeCompare(right.id);
  });
  const facts = emptyFacts();
  const snapshots: ReplayedProfileSnapshot[] = [];
  let previousSequence = 0n;
  for (const [index, event] of ordered.entries()) {
    if (event.sequence <= previousSequence) {
      throw new Error("Profile event sequence must be strictly increasing");
    }
    previousSequence = event.sequence;
    applyEvent(facts, event);
    const version = baseVersion + index + 1;
    const factsJson = structuredClone(facts);
    const snapshotHash = canonicalSha256({
      version,
      source_sequence: event.sequence.toString(),
      consent_epoch: event.consentEpoch,
      facts: factsJson,
    });
    snapshots.push({
      version,
      sourceEventId: event.id,
      sourceSequence: event.sequence,
      consentEpoch: event.consentEpoch,
      factsJson,
      snapshotHash,
    });
  }
  return snapshots;
}

export class ProfileProjectionWorker {
  private readonly consumer = "profile-snapshot-projector-v1";

  constructor(
    private readonly database: PrismaClient,
    private readonly config: ProfileProjectionWorkerConfig,
  ) {}

  async claim(outboxId: string) {
    const now = new Date();
    const leaseToken = randomUUID();
    const claimed = await this.database.domainOutbox.updateMany({
      where: {
        id: outboxId,
        eventType: "profile.event.appended",
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
    if (claimed.count !== 1) throw new Error("Profile projection message is not claimable");
    return this.database.domainOutbox.findUniqueOrThrow({ where: { id: outboxId } });
  }

  async process(outboxId: string, leaseToken: string): Promise<void> {
    const observed = await this.database.domainOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!observed) throw new Error("Profile projection message not found");
    if (observed.status === "sent") {
      const processed = await this.database.consumerInbox.findUnique({
        where: { consumer_messageId: { consumer: this.consumer, messageId: outboxId } },
      });
      if (processed) return;
    }
    this.assertLiveLease(observed, leaseToken);

    await this.database.$transaction(async (tx) => {
      if (!observed.userId) throw new Error("Profile projection user is missing");
      await tx.$queryRaw`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${observed.userId}::uuid
        FOR UPDATE
      `;
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
        where: { consumer_messageId: { consumer: this.consumer, messageId: message.id } },
      });
      if (processed) {
        await tx.domainOutbox.update({
          where: { id: message.id },
          data: { status: "sent", leaseToken: null, leaseUntil: null },
        });
        return;
      }
      this.assertLiveLease(message, leaseToken);
      const healthRequirement = message.consentRequirements.find(
        (requirement) => requirement.purpose === "health_processing",
      );
      if (
        !message.user ||
        !healthRequirement ||
        !this.isAuthorized(
          message.user.status,
          message.user.consents,
          message.consentRequirements,
        )
      ) {
        await tx.domainOutbox.update({
          where: { id: message.id },
          data: { status: "suppressed", leaseToken: null, leaseUntil: null },
        });
        return;
      }

      const target = this.targetFromPayload(message.payload);
      const targetEvent = await tx.profileEvent.findUniqueOrThrow({
        where: { id: target.eventId },
      });
      if (
        targetEvent.userId !== message.user.id ||
        targetEvent.sequence !== target.sequence ||
        targetEvent.consentEpoch !== healthRequirement.grantEpoch
      ) {
        throw new Error("Profile projection provenance is invalid");
      }
      const sourceEvents = await tx.profileEvent.findMany({
        where: {
          userId: message.user.id,
          consentEpoch: healthRequirement.grantEpoch,
          sequence: { lte: target.sequence },
        },
        orderBy: { sequence: "asc" },
      });
      const currentEpochSnapshots = await tx.profileSnapshot.findMany({
        where: {
          userId: message.user.id,
          consentEpoch: healthRequirement.grantEpoch,
          sourceSequence: { lte: target.sequence },
        },
        orderBy: { version: "asc" },
      });
      const lastOtherEpoch = await tx.profileSnapshot.findFirst({
        where: {
          userId: message.user.id,
          consentEpoch: { not: healthRequirement.grantEpoch },
        },
        orderBy: { version: "desc" },
      });
      const baseVersion = currentEpochSnapshots[0]
        ? currentEpochSnapshots[0].version - 1
        : lastOtherEpoch?.version ?? 0;
      const replayed = replayProfileEvents(sourceEvents, baseVersion);
      for (const [index, existing] of currentEpochSnapshots.entries()) {
        const expected = replayed[index];
        if (
          !expected ||
          existing.version !== expected.version ||
          existing.sourceSequence !== expected.sourceSequence ||
          existing.snapshotHash !== expected.snapshotHash
        ) {
          throw new Error("Stored profile projection diverges from deterministic replay");
        }
      }
      for (const snapshot of replayed.slice(currentEpochSnapshots.length)) {
        await tx.profileSnapshot.create({
          data: {
            userId: message.user.id,
            version: snapshot.version,
            factsJson: snapshot.factsJson as unknown as Prisma.InputJsonValue,
            sourceEventUntil: snapshot.sourceEventId,
            sourceSequence: snapshot.sourceSequence,
            consentEpoch: snapshot.consentEpoch,
            snapshotHash: snapshot.snapshotHash,
          },
        });
      }
      await tx.consumerInbox.create({
        data: {
          consumer: this.consumer,
          messageId: message.id,
          resultHash: canonicalSha256({
            target_sequence: target.sequence.toString(),
            snapshot_hashes: replayed.map((snapshot) => snapshot.snapshotHash),
          }),
        },
      });
      await tx.domainOutbox.update({
        where: { id: message.id },
        data: { status: "sent", leaseToken: null, leaseUntil: null },
      });
    });
  }

  private assertLiveLease(
    message: { status: string; leaseToken: string | null; leaseUntil: Date | null },
    leaseToken: string,
  ): void {
    if (
      message.status !== "leased" ||
      message.leaseToken !== leaseToken ||
      !message.leaseUntil || message.leaseUntil <= new Date()
    ) {
      throw new Error("Profile projection lease is stale");
    }
  }

  private targetFromPayload(payload: Prisma.JsonValue): { eventId: string; sequence: bigint } {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Profile projection payload is invalid");
    }
    const eventId = payload.profile_event_id;
    const sequence = payload.event_sequence;
    if (typeof eventId !== "string" || typeof sequence !== "string" || !/^\d+$/.test(sequence)) {
      throw new Error("Profile projection target is invalid");
    }
    return { eventId, sequence: BigInt(sequence) };
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
