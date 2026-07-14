import type { CoachProviderContext } from "../coach/coach-context";

export type { CoachProviderContext } from "../coach/coach-context";

export abstract class CoachProvider {
  abstract generate(context: CoachProviderContext): Promise<string>;
}

export class LocalSyntheticCoachProvider extends CoachProvider {
  async generate(context: CoachProviderContext): Promise<string> {
    return JSON.stringify({
      intent: context.policy.intent,
      short_answer: "这是基于已确认合成证据的说明。",
      reason: "HealthOS 只解释已发布行动，不改变行动、画像或安全等级。",
      action_code: context.policy.action_code,
      safety_class: context.policy.safety_class,
      source_ids: context.evidence.map((item) => item.source_id),
      needs_human_review: false,
    });
  }
}
