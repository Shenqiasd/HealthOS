import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  ConfirmationStatus,
  RecommendationReviewStatus,
  type Prisma,
} from "@prisma/client";

import { DatabaseService } from "./prisma.service";

export interface PublishRecommendationInput {
  runId: string;
  idempotencyKey: string;
  riskArea: string;
  safetyClass: string;
  actionCode: string;
  renderedPayload: Prisma.InputJsonValue;
  canonicalRuleInput: Prisma.InputJsonValue;
  provenance: Prisma.InputJsonValue;
}

function labObservationIds(input: Prisma.InputJsonValue): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const ids = (input as Prisma.InputJsonObject).lab_observation_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((value): value is string => typeof value === "string");
}

@Injectable()
export class PublicationRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async publish(input: PublishRecommendationInput) {
    const observationIds = labObservationIds(input.canonicalRuleInput);

    return this.database.$transaction(async (transaction) => {
      if (observationIds.length > 0) {
        const usableCount = await transaction.labObservation.count({
          where: {
            id: { in: observationIds },
            confirmationStatus: ConfirmationStatus.usable,
          },
        });
        if (usableCount !== observationIds.length) {
          throw new BadRequestException(
            "Published recommendations cannot reference unconfirmed lab observations",
          );
        }
      }

      const latest = await transaction.recommendationSnapshot.aggregate({
        where: { runId: input.runId },
        _max: { revision: true },
      });
      const snapshot = await transaction.recommendationSnapshot.create({
        data: {
          runId: input.runId,
          revision: (latest._max.revision ?? 0) + 1,
          riskArea: input.riskArea,
          safetyClass: input.safetyClass,
          actionCode: input.actionCode,
          renderedPayloadJson: input.renderedPayload,
          canonicalRuleInputJson: input.canonicalRuleInput,
          provenanceJson: input.provenance,
          reviewStatus: RecommendationReviewStatus.published,
        },
      });

      await transaction.domainOutbox.create({
        data: {
          eventType: "recommendation.published",
          aggregateId: snapshot.id,
          payload: {
            recommendation_snapshot_id: snapshot.id,
            run_id: input.runId,
          },
          idempotencyKey: input.idempotencyKey,
        },
      });
      return snapshot;
    });
  }
}
