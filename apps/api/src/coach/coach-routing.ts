import { canonicalizeCoachSafetyText } from "./coach-safety-text";

export type CoachIntent =
  | "emergency"
  | "diagnosis_request"
  | "medication_request"
  | "unsupported_monitoring"
  | "prompt_injection"
  | "prohibited_mutation"
  | "explain_action"
  | "lighter"
  | "swap"
  | "limitation_candidate"
  | "general_question";

export type CoachRoute = "fixed" | "provider";

export interface CoachRoutingInput {
  userText: string;
  ocrText?: string;
}

export interface CoachRoutingDecision {
  intent: CoachIntent;
  route: CoachRoute;
  fixedResponseCode: string | null;
}

const emergency = /(?:\b(?:heart attack|cardiac arrest|chest pain|cannot breathe|can't breathe|can not breathe|cannot get enough air|can't get enough air|can not get enough air|cannot draw (?:a )?breath|can't draw (?:a )?breath|can't catch (?:my )?breath|struggl(?:e|ing) to breathe|difficulty breathing|shortness of breath|passed out|blacked out|lost consciousness|lost awareness|unconscious|fainted|fainting|choking|can't swallow|cannot swallow|stroke|seizure|overdose|suicid(?:e|al)|hurt myself|harm myself|emergency|ambulance)\b|\bthroat\b.{0,18}\b(?:clos(?:e|ed|ing)|swell(?:ing|ed)?|blocked)\b|\bchest\b.{0,18}\b(?:crush(?:ed|ing)|pressure|tight(?:ness)?|squeez(?:ed|ing))\b|胸痛|胸口.{0,12}(?:压住|压迫|发紧|紧缩)|喉咙.{0,10}(?:堵住|肿胀|闭合)|窒息|噎住|心梗|心脏病发作|心脏骤停|喘不(?:过|上)气|呼吸困难|无法呼吸|昏迷|晕倒|失去(?:意识|知觉)|没有意识|中风|脑卒中|抽搐|服药过量|自杀|伤害自己|急救|救护车)/i;
const injection = /(?:\b(?:ignore|disregard|forget|bypass|override)\b.{0,40}\b(?:previous|prior|earlier|above|all|system|developer|hidden|internal)?\s*(?:instructions?|rules?|prompts?|policy|policies)\b|\b(?:ignore|disregard|forget|bypass|override)(?:previous|prior|earlier|above|all|system|developer|hidden|internal)\s*(?:instructions?|rules?|prompts?|policy|policies)\b|\b(?:reveal|show|print|expose)\b.{0,30}\b(?:system prompt|hidden context|internal instructions?|developer message)\b|(?:忽略|无视|忘掉|绕过|覆盖).{0,20}(?:之前|前面|以上|所有|系统|内部)?.{0,12}(?:规则|指令|要求|提示|策略)|(?:显示|泄露|告诉我).{0,20}(?:系统提示|隐藏上下文|内部指令|开发者消息))/i;
const mutation = /(?:\b(?:set|make|change|update|modify|replace|override|rewrite|store|save|record|persist)\b.{0,48}\b(?:action[_ ]?code|safety[_ ]?class|source[_ ]?ids?|cited source|evidence source|profile|health profile)\b|\b(?:action[_ ]?code|safety[_ ]?class|source[_ ]?ids?)\b.{0,24}(?:\b(?:to|as|with)\b|设置|设成|修改|改成|改为|更新|替换|覆盖)|(?:设置|设成|修改|改成|改为|更新|替换|覆盖).{0,24}(?:行动代码|动作代码|安全等级|安全级别|证据来源|引用来源|来源\s*id|健康档案|健康画像|档案|画像)|(?:行动代码|动作代码|安全等级|安全级别|证据来源|引用来源|来源\s*id|健康档案|健康画像|档案|画像).{0,16}(?:设置|设成|修改|改成|改为|更新|替换|覆盖))/i;
const medicationRequests = [
  /\b(?:should|can|could|may|must|would|do)\s+i\s+(?:please\s+)?(?:take|use|inject|start|stop|skip|double|increase|decrease|reduce|change)\b.{0,48}(?:\b(?:insulin|medication|medicine|meds|pills?|tablets?|prescription|dosage|dose)\b|\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?)\b)/i,
  /\b(?:take|use|inject|start|stop|skip|double|increase|decrease|reduce|change)\b.{0,40}(?:\b(?:insulin|medication|medicine|meds|pills?|tablets?|prescription|dosage|dose)\b|\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?)\b)/i,
  /\b(?:what|which)\s+(?:medication|medicine|meds|pills?|tablets?|dose|dosage)\b.{0,20}\b(?:take|use|inject|start|stop|skip|change)\b/i,
  /\b(?:should|can|could|may|must|would|do)\s+i\s+(?:start|stop|take|use|inject|resume)\b.{0,32}\b(?:metformin|insulin|aspirin|statin|warfarin|allopurinol)\b/i,
  /(?:我|能不能|可以|应该|是否|今晚|现在).{0,16}(?:停药|开始用药|服药|吃药|注射|加大剂量|增加剂量|减少剂量|减量|双倍.{0,8}药|药.{0,8}双倍)/i,
  /(?:药物|药片|剂量|胰岛素).{0,20}(?:能不能|是否|可以|应该)?.{0,10}(?:停|加倍|双倍|增加|减少|吃|服用|注射)/i,
  /(?:我该|能否|能不能|可以|应该).{0,24}(?:改成|换成|加到|减到).{0,8}(?:\d+|[一二两三四五六七八九十]+)(?:片|粒|毫克|单位)/i,
  /(?:我该|能否|能不能|可以|应该).{0,20}(?:开始|停止|继续|恢复)?(?:吃|服用|注射)?.{0,8}(?:二甲双胍|胰岛素|阿司匹林|他汀|华法林|别嘌醇)/i,
];
const diagnosis = /(?:\bdiagnos(?:e|ed|is|tic)\b|\b(?:what|which)\s+(?:disease|illness|condition)\b|\b(?:disease|illness)\s+(?:do|might|could)\s+i\s+have\b|\bam\s+i\s+(?:a\s+)?(?:diabetic|[a-z][a-z -]{0,24}(?:patient|case))\b|\b(?:do|could|might|may)\s+i\s+have\s+(?:diabetes|cancer|lupus|asthma|hypertension|gout|hepatitis|[a-z][a-z -]{0,24}(?:disease|illness|condition|syndrome))\b|\b(?:could|might|may|does|is)\s+(?:this|that|it)\s+(?:be|mean|indicate|show)\b.{0,24}\b(?:diabetes|cancer|lupus|asthma|[a-z][a-z -]{0,24}(?:disease|illness|condition|syndrome))\b|\b(?:could|might|can)\s+(?:diabetes|cancer|lupus|asthma|[a-z][a-z -]{0,24}(?:disease|illness|condition|syndrome))\s+(?:explain|cause|account for)\b|\b(?:could|might|can|is|are)\b.{0,24}\b(?:my\s+)?(?:liver|kidneys?|lungs?|heart|diabetes|cancer|lupus)\b.{0,20}\b(?:diseased|disease|ill|condition|what\s+i\s+have|have)\b|\bis\s+(?:diabetes|cancer|lupus|asthma|[a-z][a-z -]{0,24}(?:disease|illness|condition|syndrome))\b.{0,20}\b(?:what\s+)?i\s+have\b|\b(?:results?|this|that)\b.{0,20}\b(?:mean|means|indicate|shows?)\b.{0,20}\b(?:disease|illness|condition)\b|诊断|确诊|(?:得了|患了|有).{0,8}(?:什么病|哪种病|疾病|红斑狼疮|糖尿病|癌症|肝病|肾病)|什么病|是不是.{0,10}(?:糖尿病|癌|疾病|肝病|肾病|红斑狼疮|哮喘))/i;
const unsupportedMonitoring = /(?:\b(?:real[- ]?time|continuous(?:ly)?|all day|24\s*\/\s*7|around the clock|constantly)\b.{0,30}\b(?:monitor|monitoring|watch|watching|track|tracking)\b|\b(?:monitor|watch|track)(?:ing)?\b.{0,30}\b(?:all day|24\s*\/\s*7|constantly|my vitals|heart rate)\b|(?:实时|全天|一直|持续|不间断|二十四小时).{0,20}(?:监测|监控|盯着|追踪)|(?:监测|监控|盯着|追踪).{0,20}(?:全天|一直|持续|心率|生命体征))/i;
const safeLighter = [
  /^(?:please\s+)?make\s+(?:(?:today'?s?|the|this|my|current)\s+)?(?:(?:medication\s+)?explanation|walk|action|recommendation)\s+(?:lighter|easier|less\s+intense)[?.!]*$/i,
  /^(?:could|can|would)\s+you\s+make\s+(?:(?:today'?s?|the|this|my|current)\s+)?(?:walk|action|recommendation)\s+(?:a\s+bit\s+)?(?:gentler|lighter|easier|less\s+intense)[?.!]*$/i,
  /^(?:give\s+me|choose)\s+(?:a\s+)?lighter\s+(?:action|walk|recommendation)[?.!]*$/i,
  /^(?:换|改)(?:得)?轻一点[？?。!]*$/i,
  /^(?:轻一点|简单一点)[？?。!]*$/i,
  /^(?:请)?把(?:今天的|当前的|这个)?(?:行动|动作|推荐)(?:调|改)(?:轻|简单)(?:一点|一些)[？?。!]*$/i,
];
const safeSwap = [
  /^(?:please\s+)?(?:swap|replace)\s+(?:(?:today'?s?|the|this|my|current)\s+)?(?:action|walk|recommendation)(?:\s+because\s+it\s+mentions\s+(?:pills?|medication))?[?.!]*$/i,
  /^give\s+me\s+(?:a|another)\s+(?:different|replacement|new)\s+(?:action|walk|recommendation)[?.!]*$/i,
  /^(?:can|could|may)\s+i\s+have\s+(?:an?|another)\s+(?:alternative|different|replacement|new)\s+(?:action|walk|recommendation)[?.!]*$/i,
  /^(?:换一个|替换)(?:行动|动作|推荐)[？?。!]*$/i,
  /^换个别的(?:行动|动作|推荐)吧?[？?。!]*$/i,
];
const safeExplain = [
  /^(?:why|为什么)[?？。!]*$/i,
  /^(?:please\s+)?(?:explain|elucidate)\s+(?:(?:the\s+)?(?:today'?s?|this|current|my)\s+|the\s+)?(?:action|walk|recommendation|report|result|scan|source|sleep|activity|progress|trend)s?[?.!]*$/i,
  /^(?:give|show)\s+me\s+(?:an?\s+)?explanation(?:\s+(?:of|for)\s+(?:(?:today'?s?|the|this|current|my)\s+)?(?:action|walk|recommendation))?[?.!]*$/i,
  /^tell\s+me\s+why\s+(?:this|that|it)\s+(?:was|is)\s+recommended[?.!]*$/i,
  /^why\s+(?:was|is)\s+(?:(?:today'?s?|the|this|current|my)\s+)?(?:action|walk|recommendation)\s+recommended[?.!]*$/i,
  /^why\s+is\s+my\s+(?:medication|medicine)\s+listed\s+in\s+(?:this|the)\s+source[?.!]*$/i,
  /^为什么(?:会|要|给我)?推荐(?:今天)?(?:饭后散步|这个行动|这项行动|当前行动)[？?。!]*$/i,
  /^(?:请)?(?:解释|说明)(?:一下)?(?:这份|这个|当前|今天的)?(?:行动|动作|推荐|来源|报告|结果|睡眠|活动|进展|趋势)[？?。!]*$/i,
  /^(?:请)?讲讲为什么推荐(?:这个|当前|今天的)?(?:行动|动作|推荐)[？?。!]*$/i,
];
const safeGeneral = [
  /^how\s+(?:did\s+i\s+sleep|was\s+i\s+active|active\s+was\s+i|am\s+i\s+doing)\s*(?:today|this\s+week)?[?.!]*$/i,
  /^what\s+(?:is|was)\s+my\s+(?:sleep|step|activity|progress|trend|status)(?:\s+(?:today|this\s+week))?[?.!]*$/i,
  /^(?:show|summarize)\s+(?:my\s+)?(?:sleep|steps?|activity|progress|trend|status|week|review)[?.!]*$/i,
  /^what's\s+my\s+(?:sleep|activity|progress|status)\s+looking\s+like\s+(?:today|this\s+week)[?.!]*$/i,
  /^(?:今天|本周|这周|最近)(?:的)?(?:睡(?:眠|得)?|步数|活动|运动|状态|进展|趋势|回顾)(?:怎么样|如何|多少|有什么变化|情况如何)?[？?。!]*$/i,
  /^(?:睡(?:眠|得)?|步数|活动|运动|状态|进展|趋势|回顾)(?:怎么样|如何|多少|变化|情况)(?:今天|本周|这周)?[？?。!]*$/i,
  /^(?:本周|这周)(?:的)?(?:活动|运动|睡眠|状态|进展|趋势)表现(?:怎样|如何|怎么样)[？?。!]*$/i,
];

function normalizedText(input: CoachRoutingInput): { all: string; user: string; ocr: string } {
  const user = canonicalizeCoachSafetyText(input.userText);
  const ocr = canonicalizeCoachSafetyText(input.ocrText ?? "");
  return { all: `${user} ${ocr}`.trim(), user, ocr };
}

export function classifyCoachRequest(input: CoachRoutingInput): CoachRoutingDecision {
  const text = normalizedText(input);
  const decision = (intent: CoachIntent, route: CoachRoute, fixedResponseCode: string | null = null) =>
    ({ intent, route, fixedResponseCode });
  if (emergency.test(text.all)) {
    return decision("emergency", "fixed", "coach.emergency.zh-CN");
  }
  if (injection.test(text.all)) return decision("prompt_injection", "fixed", "coach.untrusted_input");
  if (mutation.test(text.all)) return decision("prohibited_mutation", "fixed", "coach.mutation_boundary");
  if (medicationRequests.some((pattern) => pattern.test(text.all))) {
    return decision("medication_request", "fixed", "coach.medication_boundary");
  }
  if (diagnosis.test(text.all)) {
    return decision("diagnosis_request", "fixed", "coach.diagnosis_boundary");
  }
  if (unsupportedMonitoring.test(text.all)) {
    return decision("unsupported_monitoring", "fixed", "coach.not_realtime_monitoring");
  }
  if (/记下|记录.{0,6}(限制|不适)|膝盖不适|行动不便|limitation/i.test(text.user)) {
    return decision("limitation_candidate", "fixed", "coach.limitation_pending_confirmation");
  }
  if (text.ocr) return decision("prompt_injection", "fixed", "coach.untrusted_input");
  if (safeLighter.some((pattern) => pattern.test(text.user))) return decision("lighter", "provider");
  if (safeSwap.some((pattern) => pattern.test(text.user))) return decision("swap", "provider");
  if (safeExplain.some((pattern) => pattern.test(text.user))) return decision("explain_action", "provider");
  if (safeGeneral.some((pattern) => pattern.test(text.user))) return decision("general_question", "provider");
  return decision("general_question", "fixed", "coach.safe_scope_boundary");
}
