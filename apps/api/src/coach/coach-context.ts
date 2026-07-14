import { ConflictException } from "@nestjs/common";

import type { CoachIntent } from "./coach-routing";

export type CoachSafetyClass = "normal" | "caution" | "doctor" | "blocked";

export interface CoachEvidence {
  sourceId: string;
  sourceType: "recommendation_snapshot" | "signal_snapshot" | "profile_snapshot" | "public_safety_knowledge";
  snapshotHash: string;
  capturedAt: string;
  freshness: "current" | "stale" | "unknown";
  actionCode: string | null;
  safetyClass: CoachSafetyClass;
  confirmed: boolean;
  immutable: boolean;
}

export interface CoachProviderContext {
  schema_version: 1;
  policy: { intent: CoachIntent; action_code: string | null; safety_class: CoachSafetyClass };
  evidence: Array<{
    source_id: string;
    source_type: CoachEvidence["sourceType"];
    snapshot_hash: string;
    captured_at: string;
  }>;
  untrusted_input: { user_text: string; ocr_text: string | null };
}

export function assembleCoachContext(input: {
  intent: CoachIntent;
  evidence: CoachEvidence[];
  userText: string;
  ocrText?: string;
}): CoachProviderContext {
  if (input.evidence.length === 0) throw new ConflictException("Coach has no evidence");
  if (input.evidence.some((item) => item.freshness !== "current")) {
    throw new ConflictException("Coach evidence is stale");
  }
  if (input.evidence.some((item) => !item.confirmed)) {
    throw new ConflictException("Coach evidence is not confirmed");
  }
  if (input.evidence.some((item) => !item.immutable)) {
    throw new ConflictException("Coach evidence is not immutable");
  }
  const first = input.evidence[0]!;
  if (input.evidence.some((item) => item.actionCode !== first.actionCode || item.safetyClass !== first.safetyClass)) {
    throw new ConflictException("Coach evidence policy is inconsistent");
  }
  return {
    schema_version: 1,
    policy: {
      intent: input.intent,
      action_code: first.actionCode,
      safety_class: first.safetyClass,
    },
    evidence: input.evidence.map((item) => ({
      source_id: item.sourceId,
      source_type: item.sourceType,
      snapshot_hash: item.snapshotHash,
      captured_at: item.capturedAt,
    })),
    untrusted_input: {
      user_text: input.userText,
      ocr_text: input.ocrText ?? null,
    },
  };
}
