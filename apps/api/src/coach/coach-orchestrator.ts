import { createHash } from "node:crypto";

import { ConflictException, ForbiddenException } from "@nestjs/common";

import type { CoachProvider } from "../ai/coach-provider";
import { validateBufferedCoachOutput } from "../ai/coach-provider-boundary";
import { assembleCoachContext, type CoachEvidence, type CoachSafetyClass } from "./coach-context";
import { classifyCoachRequest, type CoachIntent } from "./coach-routing";

export interface CoachGateSnapshot {
  userId: string;
  threadId: string;
  summaryVersion: number;
  consentEpoch: number;
  featureVersion: number;
  featureEnabled: boolean;
  killSwitchVersion: number;
  killSwitchActive: boolean;
  controlEpoch: string;
  localDate: string;
}

export type CoachAuthorizationMode = "provider" | "fixed" | "limitation";

export interface CoachSendCommand {
  userId: string;
  threadId: string;
  idempotencyKey: string;
  expectedSummaryVersion: number;
  userText: string;
  ocrText?: string;
}

export interface CoachTurnStore {
  executeOnce<T>(key: string, hash: string, operation: () => Promise<T>): Promise<T>;
  persistPair(input: CoachTurnResult & {
    user_id: string;
    thread_id: string;
    idempotency_key: string;
    request_hash: string;
    user_text: string;
    ocr_text: string | null;
    gate: CoachGateSnapshot;
  }): Promise<unknown>;
}

export interface CoachTurnResult {
  intent: CoachIntent;
  short_answer: string;
  reason: string;
  action_code: string | null;
  safety_class: CoachSafetyClass;
  source_ids: string[];
  needs_human_review: boolean;
  fixed_response: boolean;
  fixed_response_code: string | null;
  candidate: { id: string; status: string } | null;
}

type Dependencies = {
  turns: CoachTurnStore;
  provider: CoachProvider;
  authorize(command: CoachSendCommand, mode: CoachAuthorizationMode): Promise<CoachGateSnapshot>;
  recheck(command: CoachSendCommand, mode: Exclude<CoachAuthorizationMode, "limitation">): Promise<CoachGateSnapshot>;
  loadEvidence(command: CoachSendCommand, gate: CoachGateSnapshot): Promise<CoachEvidence[]>;
  proposeLimitation(input: {
    userId: string;
    sourceText: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }>;
};

const fixedCopy: Record<string, { answer: string; reason: string; safety: CoachSafetyClass }> = {
  "coach.emergency.zh-CN": {
    answer: "如有胸痛、呼吸困难或其他急性危险，请立即联系当地急救服务。HealthOS 不是实时监护服务。",
    reason: "紧急情况使用固定求助路径，不调用生成服务。",
    safety: "doctor",
  },
  "coach.diagnosis_boundary": {
    answer: "HealthOS 不能作出诊断。请联系合格医务人员评估。",
    reason: "诊断请求超出 Coach 边界。",
    safety: "doctor",
  },
  "coach.medication_boundary": {
    answer: "不要根据 HealthOS 改变药物或剂量，请咨询开药医生或药师。",
    reason: "用药变更请求使用固定安全文案。",
    safety: "doctor",
  },
  "coach.not_realtime_monitoring": {
    answer: "HealthOS 不提供实时监护，也不能替代急救或临床监测。",
    reason: "明确非实时服务限制。",
    safety: "caution",
  },
  "coach.untrusted_input": {
    answer: "这段内容包含无法信任的指令，HealthOS 不会据此改变安全策略或显示隐藏信息。",
    reason: "用户和 OCR 文本始终作为不可信数据处理。",
    safety: "blocked",
  },
  "coach.mutation_boundary": {
    answer: "Coach 不能直接修改行动、健康档案、来源或安全等级。",
    reason: "状态变更只能通过确定性应用服务和用户确认完成。",
    safety: "blocked",
  },
  "coach.safe_scope_boundary": {
    answer: "我只能解释当前已发布行动、健康趋势和周回顾，或帮助你选择更轻和可替换的行动。",
    reason: "未识别的自由文本不会发送给生成服务。",
    safety: "caution",
  },
  "coach.limitation_pending_confirmation": {
    answer: "已建立待确认的限制候选；确认前不会写入健康档案。",
    reason: "限制必须由用户通过现有候选确认流程确认。",
    safety: "normal",
  },
  "coach.evidence_unavailable": {
    answer: "目前没有足够的新鲜、已确认证据来回答这个问题。",
    reason: "Coach 对缺失或陈旧证据保持克制。",
    safety: "caution",
  },
};

function requestHash(command: CoachSendCommand): string {
  return createHash("sha256").update(JSON.stringify({
    user_id: command.userId,
    thread_id: command.threadId,
    expected_summary_version: command.expectedSummaryVersion,
    user_text: command.userText,
    ocr_text: command.ocrText ?? null,
  })).digest("hex");
}

function assertGate(command: CoachSendCommand, gate: CoachGateSnapshot, providerRequired: boolean): void {
  if (gate.userId !== command.userId || gate.threadId !== command.threadId) {
    throw new ForbiddenException("Coach thread ownership is invalid");
  }
  if (gate.summaryVersion !== command.expectedSummaryVersion) {
    throw new ConflictException("Coach summary version drifted");
  }
  if (providerRequired && !gate.featureEnabled) throw new ForbiddenException("Coach LLM feature is disabled");
  if (providerRequired && gate.killSwitchActive) throw new ForbiddenException("Coach LLM kill switch is active");
}

function sameAuthorization(before: CoachGateSnapshot, after: CoachGateSnapshot): boolean {
    return before.userId === after.userId && before.threadId === after.threadId &&
    before.summaryVersion === after.summaryVersion && before.consentEpoch === after.consentEpoch &&
    before.featureVersion === after.featureVersion && before.featureEnabled === after.featureEnabled &&
    before.killSwitchVersion === after.killSwitchVersion && before.killSwitchActive === after.killSwitchActive &&
    before.controlEpoch === after.controlEpoch && before.localDate === after.localDate;
}

export class CoachOrchestrator {
  constructor(private readonly dependencies: Dependencies) {}

  async send(command: CoachSendCommand): Promise<CoachTurnResult> {
    if (!/^[0-9a-f-]{36}$/i.test(command.idempotencyKey) || command.userText.trim().length === 0 || command.userText.length > 4_000) {
      throw new ConflictException("Coach command is invalid");
    }
    const hash = requestHash(command);
    return this.dependencies.turns.executeOnce(`${command.userId}:${command.idempotencyKey}`, hash, async () => {
      const routing = classifyCoachRequest({ userText: command.userText, ...(command.ocrText ? { ocrText: command.ocrText } : {}) });
      const mode: CoachAuthorizationMode = routing.route === "provider"
        ? "provider"
        : routing.intent === "limitation_candidate" ? "limitation" : "fixed";
      const before = await this.dependencies.authorize(command, mode);
      assertGate(command, before, routing.route === "provider");

      let candidate: { id: string; status: string } | null = null;
      if (routing.intent === "limitation_candidate") {
        candidate = await this.dependencies.proposeLimitation({
          userId: command.userId,
          sourceText: command.userText,
          idempotencyKey: `coach-candidate:${command.idempotencyKey}`,
        });
      }

      let result: CoachTurnResult;
      if (routing.route === "fixed") {
        const copy = fixedCopy[routing.fixedResponseCode ?? "coach.mutation_boundary"]!;
        result = {
          intent: routing.intent,
          short_answer: copy.answer,
          reason: copy.reason,
          action_code: null,
          safety_class: copy.safety,
          source_ids: [],
          needs_human_review: copy.safety === "doctor",
          fixed_response: true,
          fixed_response_code: routing.fixedResponseCode,
          candidate,
        };
      } else {
        let context;
        try {
          context = assembleCoachContext({
            intent: routing.intent,
            evidence: await this.dependencies.loadEvidence(command, before),
            userText: command.userText,
            ...(command.ocrText ? { ocrText: command.ocrText } : {}),
          });
        } catch {
          const copy = fixedCopy["coach.evidence_unavailable"]!;
          result = {
            intent: routing.intent,
            short_answer: copy.answer,
            reason: copy.reason,
            action_code: null,
            safety_class: copy.safety,
            source_ids: [],
            needs_human_review: false,
            fixed_response: true,
            fixed_response_code: "coach.evidence_unavailable",
            candidate: null,
          };
          return this.persist(command, hash, before, result);
        }
        const output = validateBufferedCoachOutput(
          await this.dependencies.provider.generate(context),
          {
            intent: routing.intent,
            actionCode: context.policy.action_code,
            safetyClass: context.policy.safety_class,
            sourceIds: context.evidence.map((item) => item.source_id),
          },
        );
        const after = await this.dependencies.recheck(command, "provider");
        if (!sameAuthorization(before, after)) {
          throw new ForbiddenException("Coach authorization changed during provider invocation");
        }
        assertGate(command, after, true);
        result = {
          ...output,
          fixed_response: false,
          fixed_response_code: null,
          candidate: null,
        };
      }
      if (routing.route === "fixed") {
        const after = await this.dependencies.recheck(command, "fixed");
        if (!sameAuthorization(before, after)) {
          throw new ForbiddenException("Coach authorization changed before persistence");
        }
        assertGate(command, after, false);
        return this.persist(command, hash, after, result);
      }
      return this.persist(command, hash, before, result);
    });
  }

  private async persist(
    command: CoachSendCommand,
    hash: string,
    gate: CoachGateSnapshot,
    result: CoachTurnResult,
  ): Promise<CoachTurnResult> {
    await this.dependencies.turns.persistPair({
      ...result,
      user_id: command.userId,
      thread_id: command.threadId,
      idempotency_key: command.idempotencyKey,
      request_hash: hash,
      user_text: command.userText,
      ocr_text: command.ocrText ?? null,
      gate,
    });
    return result;
  }
}
