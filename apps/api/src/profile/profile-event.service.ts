import {
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import type { Prisma, ProfileEvent } from "@prisma/client";

import type { DatabaseService } from "../database/prisma.service";
import { canonicalSha256 } from "./canonical-json";

export const PROFILE_EVENT_TYPES = [
  "daily_health_facts_accepted",
  "lab_value_corrected",
  "limitation_confirmed",
] as const;

export type ProfileEventType = (typeof PROFILE_EVENT_TYPES)[number];

export interface AppendProfileEventInput {
  eventType: ProfileEventType;
  source: string;
  payload: Record<string, unknown>;
  correlationId: string;
  occurredAt?: Date;
}

function assertExactKeys(
  payload: Record<string, unknown>,
  required: readonly string[],
): void {
  const keys = Object.keys(payload).sort();
  const expected = [...required].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ConflictException("Profile event payload schema is invalid");
  }
}

function validatePayload(input: AppendProfileEventInput): void {
  if (!PROFILE_EVENT_TYPES.includes(input.eventType)) {
    throw new ConflictException("Unsupported profile event type; allowlist required");
  }
  if (!input.source || input.source.length > 80) {
    throw new ConflictException("Profile event source is invalid");
  }
  if (input.eventType === "limitation_confirmed") {
    assertExactKeys(input.payload, ["active", "code"]);
    if (
      typeof input.payload.code !== "string" ||
      !/^[a-z][a-z0-9_]{1,63}$/.test(input.payload.code) ||
      typeof input.payload.active !== "boolean"
    ) {
      throw new ConflictException("Limitation payload is invalid");
    }
  }
  if (input.eventType === "lab_value_corrected") {
    assertExactKeys(input.payload, ["field_code", "unit", "value"]);
    if (
      typeof input.payload.field_code !== "string" ||
      !/^[a-z][a-z0-9_]{1,63}$/.test(input.payload.field_code) ||
      typeof input.payload.unit !== "string" ||
      input.payload.unit.length === 0 || input.payload.unit.length > 32 ||
      typeof input.payload.value !== "number" || !Number.isFinite(input.payload.value)
    ) {
      throw new ConflictException("Corrected lab payload is invalid");
    }
  }
  if (input.eventType === "daily_health_facts_accepted") {
    assertExactKeys(input.payload, ["facts", "server_sequence", "sync_run_id"]);
    if (
      typeof input.payload.sync_run_id !== "string" ||
      typeof input.payload.server_sequence !== "string" ||
      !Array.isArray(input.payload.facts)
    ) {
      throw new ConflictException("Daily health profile payload is invalid");
    }
  }
}

export class ProfileEventService {
  constructor(private readonly database: DatabaseService) {}

  async append(userId: string, input: AppendProfileEventInput): Promise<ProfileEvent> {
    validatePayload(input);
    return this.database.$transaction(async (tx) => {
      const consentEpoch = await this.requireCurrentConsent(tx, userId);
      return this.appendAuthorized(tx, userId, consentEpoch, input);
    });
  }

  async requireCurrentConsent(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<number> {
    await tx.$queryRaw`
      SELECT "id"
      FROM "users"
      WHERE "id" = ${userId}::uuid
      FOR UPDATE
    `;
    const user = await tx.user.findUnique({ where: { id: userId } });
    const consent = await tx.consentRecord.findFirst({
      where: { userId, consentType: "health_processing" },
      orderBy: { epoch: "desc" },
    });
    if (!user || user.status !== "active" || !consent?.granted) {
      throw new ForbiddenException("Current health-processing consent is required");
    }
    return consent.epoch;
  }

  async appendAuthorized(
    tx: Prisma.TransactionClient,
    userId: string,
    consentEpoch: number,
    input: AppendProfileEventInput,
  ): Promise<ProfileEvent> {
    validatePayload(input);
    const payloadHash = canonicalSha256({
      event_type: input.eventType,
      source: input.source,
      payload: input.payload,
      occurred_at: input.occurredAt?.toISOString() ?? null,
    });
    const existing = await tx.profileEvent.findUnique({
      where: {
        userId_correlationId: { userId, correlationId: input.correlationId },
      },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash || existing.consentEpoch !== consentEpoch) {
        throw new ConflictException("Profile event correlation ID was reused");
      }
      return existing;
    }
    const event = await tx.profileEvent.create({
      data: {
        userId,
        consentEpoch,
        eventType: input.eventType,
        source: input.source,
        payload: input.payload as Prisma.InputJsonValue,
        payloadHash,
        correlationId: input.correlationId,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      },
    });
    await tx.domainOutbox.create({
      data: {
        userId,
        aggregateId: event.id,
        eventType: "profile.event.appended",
        idempotencyKey: `profile.event.appended:${event.id}`,
        payload: {
          profile_event_id: event.id,
          event_sequence: event.sequence.toString(),
        },
        consentRequirements: {
          create: { purpose: "health_processing", grantEpoch: consentEpoch },
        },
      },
    });
    return event;
  }
}
