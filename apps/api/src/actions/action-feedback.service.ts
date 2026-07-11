import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ActionFeedbackCommand,
  ActionFeedbackReason,
  ActionFeedbackResponse,
} from "@healthos/contracts";
import {
  evaluateRule,
  getAction,
  isRuleInput,
  type ActionCode,
} from "@healthos/rules";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";

export interface ApplyActionFeedbackInput {
  command: ActionFeedbackCommand;
  reasonCode?: ActionFeedbackReason;
  expectedVersion: number;
  idempotencyKey: string;
}

type AssignmentRecord = {
  id: string;
  actionCode: string | null;
  status: string;
  version: number;
  difficulty: string;
};

interface ActionChainRow {
  action_code: string | null;
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function requestHash(userId: string, actionId: string, input: ApplyActionFeedbackInput): string {
  return createHash("sha256").update(JSON.stringify({
    user_id: userId,
    action_id: actionId,
    command: input.command,
    reason_code: input.reasonCode ?? null,
    expected_version: input.expectedVersion,
    idempotency_key: input.idempotencyKey,
  })).digest("hex");
}

function assignment(record: AssignmentRecord): ActionFeedbackResponse["original_action"] {
  if (!record.actionCode) throw new ConflictException("Action assignment code is unavailable");
  return {
    id: record.id,
    code: record.actionCode,
    status: record.status as ActionFeedbackResponse["original_action"]["status"],
    version: record.version,
    difficulty: record.difficulty === "light" ? "light" : "standard",
  };
}

function storedResult(value: Prisma.JsonValue): ActionFeedbackResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConflictException("Stored feedback result is invalid");
  }
  return value as unknown as ActionFeedbackResponse;
}

function validateCommand(input: ApplyActionFeedbackInput): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.idempotencyKey) || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ConflictException("Feedback identity or version is invalid");
  }
  if (input.command === "complete" && input.reasonCode) {
    throw new ConflictException("Complete feedback does not accept a reason");
  }
  if (input.command === "skip" && !["no_time", "tired", "uncomfortable", "weather", "neutral"].includes(input.reasonCode ?? "")) {
    throw new ConflictException("Skip feedback requires a supported reason");
  }
  if (input.command === "lighter" && input.reasonCode !== "too_hard") {
    throw new ConflictException("Lighter feedback requires too_hard");
  }
}

@Injectable()
export class ActionFeedbackService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async apply(
    userId: string,
    actionId: string,
    correlationId: string,
    input: ApplyActionFeedbackInput,
    now = new Date(),
  ): Promise<ActionFeedbackResponse> {
    validateCommand(input);
    const hash = requestHash(userId, actionId, input);
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      const consent = await tx.consentRecord.findFirst({
        where: { userId, consentType: "health_processing" },
        orderBy: { epoch: "desc" },
      });
      const reconciliation = await tx.privacyReconciliation.findUnique({ where: { id: "global" } });
      if (!user || user.status !== "active" || user.deletedAt || !consent?.granted || reconciliation?.status !== "ready") {
        throw new ForbiddenException("Current health-processing authorization is required");
      }

      await tx.$queryRaw`SELECT "id" FROM "action_assignments" WHERE "id" = ${actionId}::uuid FOR UPDATE`;
      const action = await tx.actionAssignment.findUnique({
        where: { id: actionId },
        include: {
          recommendationSnapshot: {
            include: {
              publications: true,
              run: { include: { inputSnapshot: true, ruleBundle: true } },
            },
          },
        },
      });
      if (!action) throw new NotFoundException("Action assignment was not found");
      if (action.userId !== userId) throw new ForbiddenException("Action assignment is not owned by the current user");

      const replay = await tx.feedbackEvent.findUnique({
        where: {
          userId_idempotencyKey: {
            userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.requestHash !== hash) throw new ConflictException("Feedback idempotency key was reused");
        return storedResult(replay.resultJson);
      }

      const snapshot = action.recommendationSnapshot;
      const run = snapshot.run;
      const provenance = snapshot.provenanceJson &&
        typeof snapshot.provenanceJson === "object" &&
        !Array.isArray(snapshot.provenanceJson)
        ? snapshot.provenanceJson
        : null;
      const ruleKey = typeof provenance?.rule_key === "string" ? provenance.rule_key : null;
      const incidentExists = ruleKey
        ? await tx.safetyIncident.count({ where: { source: `rule:${ruleKey}` } }) > 0
        : true;
      const latestProfile = await tx.profileSnapshot.findFirst({
        where: { userId, consentEpoch: consent.epoch },
        orderBy: { version: "desc" },
      });
      if (
        action.status !== "active" ||
        !action.isPrimary ||
        action.localDate.toISOString().slice(0, 10) !== localDate(now, user.timezone) ||
        snapshot.reviewStatus !== "published" ||
        snapshot.publications.length !== 1 ||
        run.userId !== userId ||
        run.consentEpoch !== consent.epoch ||
        run.inputSnapshotId !== latestProfile?.id ||
        run.ruleBundle.status !== "active" ||
        incidentExists
      ) {
        throw new ConflictException("Action assignment is no longer current");
      }
      if (action.version !== input.expectedVersion) {
        throw new ConflictException("Action assignment version is stale");
      }
      if (!action.actionCode) throw new ConflictException("Action assignment code is unavailable");

      const eventId = randomUUID();
      let updatedOriginal: AssignmentRecord;
      let currentAction: AssignmentRecord | null = null;
      let outcome: ActionFeedbackResponse["outcome"];
      let recoveryKey: string | null = null;
      let persistedReason: ActionFeedbackReason | "no_safe_alternative" | null = input.reasonCode ?? null;

      if (input.command === "complete") {
        updatedOriginal = await tx.actionAssignment.update({
          where: { id: action.id },
          data: { status: "completed", version: { increment: 1 } },
        });
        outcome = "completed";
      } else if (input.command === "skip") {
        updatedOriginal = await tx.actionAssignment.update({
          where: { id: action.id },
          data: { status: "skipped", version: { increment: 1 } },
        });
        outcome = "skipped";
      } else {
        const ruleInputValue = run.inputSnapshot.factsJson &&
          typeof run.inputSnapshot.factsJson === "object" &&
          !Array.isArray(run.inputSnapshot.factsJson)
          ? run.inputSnapshot.factsJson.rule_input
          : null;
        const chain = await tx.$queryRaw<ActionChainRow[]>`
          WITH RECURSIVE action_chain AS (
            SELECT "id", "action_code", "replaced_by_id"
            FROM "action_assignments"
            WHERE "id" = ${action.id}::uuid
            UNION ALL
            SELECT previous."id", previous."action_code", previous."replaced_by_id"
            FROM "action_assignments" previous
            JOIN action_chain current ON previous."replaced_by_id" = current."id"
          )
          SELECT "action_code" FROM action_chain
        `;
        const historicalCodes = chain
          .map((entry) => entry.action_code)
          .filter((code): code is ActionCode => code !== null && [
            "SLEEP_WIND_DOWN",
            "SLEEP_WIND_DOWN_LIGHT",
            "POST_MEAL_WALK",
            "SUGARY_DRINK_SWAP",
          ].includes(code));
        const replacementCode = this.replacementCode(
          input.command,
          action.actionCode as ActionCode,
          ruleInputValue,
          historicalCodes,
        );
        if (!replacementCode) {
          updatedOriginal = await tx.actionAssignment.update({
            where: { id: action.id },
            data: { status: "skipped", version: { increment: 1 } },
          });
          outcome = "no_safe_alternative";
          recoveryKey = "action.feedback.no_safe_alternative";
          persistedReason = input.reasonCode ?? "no_safe_alternative";
        } else {
          const definition = getAction(replacementCode);
          const proposed = await tx.actionAssignment.create({
            data: {
              userId,
              recommendationSnapshotId: snapshot.id,
              localDate: action.localDate,
              actionCode: replacementCode,
              difficulty: definition.difficulty,
              status: "proposed",
              isPrimary: true,
            },
          });
          updatedOriginal = await tx.actionAssignment.update({
            where: { id: action.id },
            data: { status: "replaced", replacedById: proposed.id, version: { increment: 1 } },
          });
          currentAction = await tx.actionAssignment.update({
            where: { id: proposed.id },
            data: { status: "active", version: { increment: 1 } },
          });
          outcome = "replaced";
        }
      }

      const result: ActionFeedbackResponse = {
        schema_version: 1,
        feedback_event_id: eventId,
        idempotency_key: input.idempotencyKey,
        outcome,
        reason_code: persistedReason,
        original_action: assignment(updatedOriginal),
        current_action: currentAction ? assignment(currentAction) : null,
        recovery_key: recoveryKey,
      };
      await tx.feedbackEvent.create({
        data: {
          id: eventId,
          userId,
          actionAssignmentId: action.id,
          type: input.command,
          reasonCode: persistedReason,
          source: "ios",
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          resultJson: result as unknown as Prisma.InputJsonObject,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: `action.feedback.${input.command}`,
          resourceType: "action_assignment",
          resourceId: action.id,
          beforeHash: createHash("sha256").update(`${action.id}:${action.version}:${action.status}`).digest("hex"),
          afterHash: createHash("sha256").update(`${updatedOriginal.id}:${updatedOriginal.version}:${updatedOriginal.status}`).digest("hex"),
        },
      });
      void correlationId;
      return result;
    }, { isolationLevel: "ReadCommitted" });
  }

  private replacementCode(
    command: "lighter" | "swap",
    currentCode: ActionCode,
    input: unknown,
    historicalCodes: ActionCode[],
  ): ActionCode | null {
    if (!isRuleInput(input)) return null;
    const reevaluated = evaluateRule({
      ...input,
      rejected_action_codes: [...new Set([...input.rejected_action_codes, ...historicalCodes, currentCode])],
    });
    if (reevaluated.outcome !== "action" || !reevaluated.actionCode || reevaluated.actionCode === currentCode) {
      return null;
    }
    if (command === "lighter") {
      return reevaluated.actionCode === getAction(currentCode).lighterVariant
        ? reevaluated.actionCode
        : null;
    }
    if (reevaluated.actionCode === getAction(currentCode).lighterVariant) return null;
    return reevaluated.actionCode;
  }
}
