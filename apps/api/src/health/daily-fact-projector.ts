import type { Prisma } from "@prisma/client";

import { sha256Hex } from "../identity/crypto";
import type { DailyHealthFactInput } from "./health-types";

export class DailyFactProjector {
  async project(
    transaction: Prisma.TransactionClient,
    input: {
      userId: string;
      syncRunId: string;
      serverSequence: bigint;
      fact: DailyHealthFactInput;
    },
  ): Promise<string | null> {
    const localDate = new Date(`${input.fact.localDate}T00:00:00.000Z`);
    const normalizedSource = [...input.fact.sourceVector]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => ({
        sourceId: source.sourceId,
        kind: source.kind,
        contribution: source.contribution,
      }));
    const inputHash = sha256Hex(JSON.stringify({
      value: input.fact.value,
      coverage: input.fact.coverage,
      sourceVector: normalizedSource,
    }));
    const current = await transaction.dailyHealthFactRevision.findFirst({
      where: {
        userId: input.userId,
        localDate,
        metric: input.fact.metric,
      },
      orderBy: [
        { serverSequence: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
    });
    if (current?.inputHash === inputHash) return null;
    const revision = await transaction.dailyHealthFactRevision.create({
      data: {
        userId: input.userId,
        localDate,
        metric: input.fact.metric,
        canonicalValueJson: { value: input.fact.value },
        coverage: input.fact.coverage,
        sourceVectorJson: normalizedSource,
        inputHash,
        supersedesId: current?.id ?? null,
        healthSyncRunId: input.syncRunId,
        serverSequence: input.serverSequence,
      },
    });
    return revision.id;
  }
}
