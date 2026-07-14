import { ConflictException } from "@nestjs/common";

import type { CoachIntent } from "../coach/coach-routing";
import type { CoachSafetyClass } from "../coach/coach-context";
import { canonicalizeCoachSafetyText } from "../coach/coach-safety-text";

export interface CoachProviderOutput {
  intent: CoachIntent;
  short_answer: string;
  reason: string;
  action_code: string | null;
  safety_class: CoachSafetyClass;
  source_ids: string[];
  needs_human_review: boolean;
}

const exactKeys = [
  "action_code", "intent", "needs_human_review", "reason",
  "safety_class", "short_answer", "source_ids",
];
const intents = new Set([
  "emergency", "diagnosis_request", "medication_request", "unsupported_monitoring",
  "prompt_injection", "prohibited_mutation", "explain_action", "lighter", "swap",
  "limitation_candidate", "general_question",
]);
const safetyClasses = new Set(["normal", "caution", "doctor", "blocked"]);
const safeProviderProse = [
  /^(?:饭后短走有助于完成今天已发布的行动|这是对既有行动的解释[，,]不会改变行动|合成说明|只解释已发布行动|这是对已发布行动的合成解释|仅引用不可变合成证据|这是基于已确认合成证据的说明|healthos 只解释已发布行动[，,]不改变行动、画像或安全等级|合成证据说明|不改变任何状态)[。.!?]?$/,
  /^the source ids are listed with this explanation[.]?$/,
  /^this action was recommended because of your (?:sleep|activity|movement|recovery) trend[.]?$/,
  /^i suggest a shorter walk for the published action[.]?$/,
  /^this action does not change your (?:medication|medicine|prescription)(?: or (?:dosage|dose))?[.]?$/,
  /^you (?:do not|don't) need to change your (?:medication|medicine|prescription)(?: or (?:dosage|dose))?[.]?$/,
  /^healthos is not an? emergency service[.]?$/,
  /^(?:do not|don't|never|no need to) (?:call|contact|dial|ring|phone) (?:911|999|112|120|emergency services?|an? ambulance)[.]?$/,
  /^(?:there is )?no need to (?:go|head|visit|present|seek|get) to? ?(?:the )?(?:er|emergency room|emergency department|emergency care|urgent care)[.]?$/,
  /^(?:an? )?(?:er|emergency room|emergency department|urgent care) visit is not (?:recommended|needed|required|warranted) by this explanation[.]?$/,
  /^(?:emergency care|an? emergency visit) is unnecessary for this explanation[.]?$/,
  /^this explanation does not warrant (?:er|emergency-room|emergency-department|urgent-care) (?:attendance|care|evaluation)[.]?$/,
  /^this is not a diagnosis[.]?$/,
  /^source ids were not (?:changed|updated|replaced|modified)[.]?$/,
  /^no update was made to your (?:profile|health profile|record|health record|chart)[.]?$/,
];
const safeCompoundProviderProse = [
  /^这是对既有行动的解释,不会改变行动[。.!?]?$/,
  /^healthos 只解释已发布行动,不改变行动、画像或安全等级[。.!?]?$/,
  /^this action does not change your (?:medication|medicine|prescription) or (?:dosage|dose)[.]?$/,
  /^this action was recommended because of your (?:sleep|activity|movement|recovery) trend[.]?$/,
];
const safeNounPhraseTemplates = [
  /^(?:do not|don't|never|no need to) (?:change|stop|start|resume|take|use|inject|administer) ([a-z0-9][a-z0-9 -]{0,48})[.]?$/,
  /^you should not (?:change|stop|start|resume|take|use|inject|administer) ([a-z0-9][a-z0-9 -]{0,48})[.]?$/,
  /^healthos cannot recommend (?:changing|increasing|decreasing|stopping|starting|taking|using) your ([a-z0-9][a-z0-9 -]{0,48})[.]?$/,
  /^no change to ([a-z0-9][a-z0-9 -]{0,48}) is being (?:advised|recommended)[.]?$/,
  /^(?:restarting|resuming|taking|using|injecting) ([a-z0-9][a-z0-9 -]{0,48}) is not recommended here[.]?$/,
  /^this does not diagnose ([a-z][a-z -]{0,48})[.]?$/,
  /^(?:these|the) findings are not consistent with ([a-z][a-z -]{0,48})[.]?$/,
  /^the findings do not support ([a-z][a-z -]{0,48})[.]?$/,
  /^([a-z][a-z -]{0,48}) is not indicated by (?:these|the) results[.]?$/,
  /^your ([a-z][a-z -]{0,32}) (?:status|flag|field) has not been (?:changed|updated|switched|modified)[.]?$/,
];
const forbiddenNounPhraseTokens = new Set([
  "i", "we", "you", "he", "she", "they", "it", "this", "that", "these", "those",
  "and", "or", "but", "however", "although", "though", "while", "yet", "then", "except",
  "unless", "whereas", "because", "so", "plus", "instead", "as", "also",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "do", "does",
  "did", "will", "would", "should", "could", "can", "may", "might", "must",
  "diagnose", "diagnoses", "diagnosed", "diagnosing", "confirm", "confirms", "confirmed", "confirming",
  "indicate", "indicates", "indicated", "show", "shows", "showed", "mean", "means", "meant",
  "suggest", "suggests", "suggested", "support", "supports", "supported", "prove", "proves", "proved",
  "start", "starts", "started", "stop", "stops", "stopped", "take", "takes", "took", "resume",
  "resumes", "resumed", "restart", "restarts", "restarted", "remain", "remains", "remained",
  "recommend", "recommends", "recommended", "advise", "advises", "advised",
  "change", "changes", "changed", "update", "updates", "updated", "set", "sets", "mark", "marks",
  "marked", "record", "records", "recorded", "enter", "enters", "entered", "identify", "identifies",
  "identified", "write", "writes", "wrote", "switch", "switches", "switched",
  "call", "calls", "called", "calling", "contact", "contacts", "contacted", "contacting",
  "dial", "dials", "dialed", "dialing", "ring", "rings", "rang", "ringing", "phone", "phones", "phoned",
  "inject", "injects", "injected", "injecting", "administer", "administers", "administered", "administering",
  "prescribe", "prescribes", "prescribed", "prescribing", "give", "gives", "gave", "given", "giving",
  "seek", "seeks", "sought", "seeking", "visit", "visits", "visited", "visiting", "attend", "attends",
  "summon", "summons", "summoned", "summoning", "dispatch", "dispatches", "dispatched", "dispatching",
]);
const forbiddenNounPhraseValues = new Set([
  "911", "999", "112", "120", "er", "emergency", "ambulance",
]);
const genericSafeNounPhrases = new Set([
  "medication", "medicine", "prescription", "dosage", "dose",
]);
const safeChineseNounPhraseTemplates = [
  /^不要(?:更改|改变|停用|开始|恢复|服用|使用|注射)([\p{Script=Han}a-z0-9 -]{1,32})[。.!?]?$/u,
  /^请不要(?:更改|改变|停用|开始|恢复|服用|使用|注射)([\p{Script=Han}a-z0-9 -]{1,32})[。.!?]?$/u,
];
const forbiddenChineseNounPhrase = /(?:拨打|呼叫|联系|求助|前往|去|急诊|急救|救护车|诊断|确诊|说明|表明|建议|推荐|开具|处方|服用|使用|注射|更改|改变|更新|写入|记录|标记|设为|改为)/u;
const unsafeBoundaryConnector = /[,;:]|\b(?:and|or|but|however|although|though|while|yet|then|except|unless|whereas|because|so|plus|instead)\b/i;

function canonicalSafetyText(value: string): string {
  return canonicalizeCoachSafetyText(value);
}

function isSafeNounPhrase(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  return tokens.length >= 1
    && tokens.length <= 4
    && tokens.every((token) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token))
    && tokens.every((token) => !forbiddenNounPhraseTokens.has(token))
    && tokens.every((token) => !forbiddenNounPhraseValues.has(token));
}

function isSafeChineseNounPhrase(value: string): boolean {
  return !forbiddenChineseNounPhrase.test(value)
    && !/(?:911|999|112|120)/u.test(value);
}

function containsAffirmativeHazard(value: string, allowedSafeTerms: ReadonlySet<string>): boolean {
  const text = canonicalSafetyText(value);
  if (safeCompoundProviderProse.some((pattern) => pattern.test(text))) return false;
  if (unsafeBoundaryConnector.test(text)) return true;
  if (safeProviderProse.some((pattern) => pattern.test(text))) return false;
  if (safeNounPhraseTemplates.some((pattern) => {
    const match = text.match(pattern);
    if (match?.[1] === undefined) return false;
    const phrase = match[1].trim();
    return isSafeNounPhrase(phrase) && allowedSafeTerms.has(phrase);
  })) return false;
  if (/^请?不要拨打(?:911|999|112|120)[。.!?]?$/u.test(text)) return false;
  return !safeChineseNounPhraseTemplates.some((pattern) => {
    const match = text.match(pattern);
    if (match?.[1] === undefined) return false;
    const phrase = match[1].trim();
    return isSafeChineseNounPhrase(phrase) && allowedSafeTerms.has(phrase);
  });
}

function bindAllowedSafeTerms(values: string[] | undefined): ReadonlySet<string> {
  const bound = new Set(genericSafeNounPhrases);
  for (const value of values ?? []) {
    const phrase = canonicalSafetyText(value);
    if (isSafeNounPhrase(phrase) || isSafeChineseNounPhrase(phrase)) bound.add(phrase);
  }
  return bound;
}

export function validateBufferedCoachOutput(
  buffer: string,
  expected: {
    intent: CoachIntent;
    actionCode: string | null;
    safetyClass: CoachSafetyClass;
    sourceIds: string[];
    allowedSafeTerms?: string[];
  },
): CoachProviderOutput {
  let value: unknown;
  try {
    value = JSON.parse(buffer);
  } catch {
    throw new ConflictException("Provider buffer is not complete JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConflictException("Provider output schema is invalid");
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (JSON.stringify(keys) !== JSON.stringify(exactKeys)) {
    throw new ConflictException("Provider output schema must have exact fields");
  }
  if (
    !intents.has(item.intent as string) ||
    typeof item.short_answer !== "string" || item.short_answer.length === 0 || item.short_answer.length > 600 ||
    typeof item.reason !== "string" || item.reason.length === 0 || item.reason.length > 1_200 ||
    (item.action_code !== null && typeof item.action_code !== "string") ||
    !safetyClasses.has(item.safety_class as string) ||
    !Array.isArray(item.source_ids) || item.source_ids.length === 0 ||
    item.source_ids.some((source) => typeof source !== "string") ||
    typeof item.needs_human_review !== "boolean"
  ) {
    throw new ConflictException("Provider output schema is invalid");
  }
  if (item.intent !== expected.intent) throw new ConflictException("Provider intent mutation is prohibited");
  if (item.action_code !== expected.actionCode) throw new ConflictException("Provider action mutation is prohibited");
  if (item.safety_class !== expected.safetyClass) throw new ConflictException("Provider safety mutation is prohibited");
  const sources = item.source_ids as string[];
  const expectedSources = [...new Set(expected.sourceIds)].sort();
  const actualSources = [...new Set(sources)].sort();
  if (
    expectedSources.length !== expected.sourceIds.length ||
    actualSources.length !== sources.length ||
    JSON.stringify(actualSources) !== JSON.stringify(expectedSources)
  ) {
    throw new ConflictException("Provider source citation mismatch");
  }
  const allowedSafeTerms = bindAllowedSafeTerms(expected.allowedSafeTerms);
  if (
    containsAffirmativeHazard(item.short_answer as string, allowedSafeTerms) ||
    containsAffirmativeHazard(item.reason as string, allowedSafeTerms)
  ) {
    throw new ConflictException("Provider output contains prohibited content");
  }
  return item as unknown as CoachProviderOutput;
}
