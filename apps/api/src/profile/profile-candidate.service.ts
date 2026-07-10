import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import type { DatabaseService } from "../database/prisma.service";
import { canonicalSha256 } from "./canonical-json";
import type { ProfileEventService } from "./profile-event.service";

export interface ProposeProfileCandidateInput {
  candidateType: "mobility_limitation";
  structuredValue: { code: string; active: boolean };
  sourceText: string;
  idempotencyKey: string;
}

export class ProfileCandidateService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: ProfileEventService,
  ) {}

  async propose(userId: string, input: ProposeProfileCandidateInput) {
    if (
      input.candidateType !== "mobility_limitation" ||
      !/^[a-z][a-z0-9_]{1,63}$/.test(input.structuredValue.code) ||
      typeof input.structuredValue.active !== "boolean" ||
      input.sourceText.trim().length === 0 || input.sourceText.length > 4_000 ||
      input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128
    ) {
      throw new ConflictException("Profile candidate is invalid");
    }
    const sourceTextHash = canonicalSha256(input.sourceText);
    const requestHash = canonicalSha256({
      candidate_type: input.candidateType,
      structured_value: input.structuredValue,
      source_text_hash: sourceTextHash,
    });
    return this.database.$transaction(async (tx) => {
      await this.events.requireCurrentConsent(tx, userId);
      const existing = await tx.profileCandidate.findUnique({
        where: {
          userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey },
        },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException("Candidate idempotency key was reused");
        }
        return existing;
      }
      return tx.profileCandidate.create({
        data: {
          userId,
          candidateType: input.candidateType,
          structuredValueJson: input.structuredValue,
          sourceTextHash,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
      });
    });
  }

  async get(userId: string, candidateId: string) {
    const candidate = await this.database.profileCandidate.findUnique({
      where: { id: candidateId },
    });
    if (!candidate || candidate.userId !== userId) {
      throw new NotFoundException("Profile candidate not found");
    }
    return candidate;
  }

  async confirm(userId: string, candidateId: string, correlationId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correlationId)) {
      throw new ConflictException("Candidate confirmation correlation ID is invalid");
    }
    return this.database.$transaction(async (tx) => {
      const consentEpoch = await this.events.requireCurrentConsent(tx, userId);
      await tx.$queryRaw`
        SELECT "id"
        FROM "profile_candidates"
        WHERE "id" = ${candidateId}::uuid
        FOR UPDATE
      `;
      const candidate = await tx.profileCandidate.findUnique({
        where: { id: candidateId },
      });
      if (!candidate || candidate.userId !== userId) {
        throw new NotFoundException("Profile candidate not found");
      }
      if (candidate.status === "rejected") {
        throw new ForbiddenException("Rejected candidate cannot be confirmed");
      }
      if (candidate.confirmedEventId) {
        return tx.profileEvent.findUniqueOrThrow({
          where: { id: candidate.confirmedEventId },
        });
      }
      if (candidate.candidateType !== "mobility_limitation") {
        throw new ConflictException("Unsupported profile candidate type");
      }
      const structured = candidate.structuredValueJson as Prisma.JsonObject;
      const event = await this.events.appendAuthorized(tx, userId, consentEpoch, {
        eventType: "limitation_confirmed",
        source: "user_confirmed_candidate",
        correlationId,
        payload: {
          code: structured.code,
          active: structured.active,
        },
      });
      await tx.profileCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "confirmed",
          confirmedEventId: event.id,
          confirmedAt: new Date(),
        },
      });
      return event;
    });
  }
}
