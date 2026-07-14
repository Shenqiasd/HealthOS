import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import type { DatabaseService } from "../database/prisma.service";
import type { CoachGateSnapshot, CoachTurnResult, CoachTurnStore } from "./coach-orchestrator";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class PrismaCoachTurnStore implements CoachTurnStore {
  private readonly transactions = new AsyncLocalStorage<Prisma.TransactionClient>();

  constructor(private readonly database: DatabaseService) {}

  currentTransaction(): Prisma.TransactionClient {
    const transaction = this.transactions.getStore();
    if (!transaction) throw new ConflictException("Coach transaction is unavailable");
    return transaction;
  }

  async executeOnce<T>(key: string, requestHash: string, operation: () => Promise<T>): Promise<T> {
    return this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coach-turn:${key}`}, 0))`;
      const [, idempotencyKey] = key.split(":");
      const userId = key.slice(0, 36);
      const replay = await tx.coachTurn.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: idempotencyKey! } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException("Coach idempotency key payload changed");
        return replay.resultJson as unknown as T;
      }
      return this.transactions.run(tx, operation);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  }

  async persistPair(input: CoachTurnResult & {
    user_id: string;
    thread_id: string;
    idempotency_key: string;
    request_hash: string;
    user_text: string;
    ocr_text: string | null;
    gate: CoachGateSnapshot;
  }): Promise<void> {
    const tx = this.currentTransaction();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coach-thread:${input.thread_id}`}, 0))`;
    const aggregate = await tx.coachMessage.aggregate({
      where: { threadId: input.thread_id },
      _max: { sequence: true },
    });
    const firstSequence = (aggregate._max.sequence ?? 0) + 1;
    const turnId = crypto.randomUUID();
    const result: CoachTurnResult = {
      intent: input.intent,
      short_answer: input.short_answer,
      reason: input.reason,
      action_code: input.action_code,
      safety_class: input.safety_class,
      source_ids: input.source_ids,
      needs_human_review: input.needs_human_review,
      fixed_response: input.fixed_response,
      fixed_response_code: input.fixed_response_code,
      candidate: input.candidate,
    };
    await tx.coachTurn.create({ data: {
      id: turnId,
      userId: input.user_id,
      threadId: input.thread_id,
      idempotencyKey: input.idempotency_key,
      requestHash: input.request_hash,
      intent: input.intent,
      resultJson: result as unknown as Prisma.InputJsonValue,
      gateEvidenceJson: input.gate as unknown as Prisma.InputJsonValue,
      candidateId: input.candidate?.id ?? null,
    } });
    const sources = input.source_ids;
    const [canonicalEvidence] = await tx.$queryRaw<Array<{
      user_hash: string;
      assistant_hash: string;
    }>>`
      SELECT
        encode(digest('[]'::jsonb::text, 'sha256'), 'hex') AS "user_hash",
        encode(digest(${JSON.stringify(sources)}::jsonb::text, 'sha256'), 'hex') AS "assistant_hash"
    `;
    if (!canonicalEvidence) throw new ConflictException("Coach evidence hashing failed");
    await tx.coachMessage.createMany({ data: [
      {
        userId: input.user_id,
        threadId: input.thread_id,
        turnId,
        sequence: firstSequence,
        role: "user",
        intent: input.intent,
        content: input.user_text,
        contentHash: hash(input.user_text),
        sourcesJson: [],
        evidenceHash: canonicalEvidence.user_hash,
        safetyClass: input.safety_class,
        actionCode: null,
        fixedResponseCode: null,
        needsHumanReview: false,
        modelMetadata: Prisma.DbNull,
      },
      {
        userId: input.user_id,
        threadId: input.thread_id,
        turnId,
        sequence: firstSequence + 1,
        role: "assistant",
        intent: input.intent,
        content: input.short_answer,
        contentHash: hash(input.short_answer),
        sourcesJson: sources,
        evidenceHash: canonicalEvidence.assistant_hash,
        safetyClass: input.safety_class,
        actionCode: input.action_code,
        fixedResponseCode: input.fixed_response_code,
        needsHumanReview: input.needs_human_review,
        modelMetadata: input.fixed_response ? Prisma.DbNull : { provider: "local_synthetic", buffered: true },
      },
    ] });
  }
}
