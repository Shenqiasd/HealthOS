import { validateBufferedCoachOutput } from "./coach-provider-boundary";

const primarySource = "11111111-1111-4111-8111-111111111111";
const expected = {
  intent: "explain_action" as const,
  actionCode: "POST_MEAL_WALK",
  safetyClass: "normal" as const,
  sourceIds: [primarySource],
  allowedSafeTerms: [
    "medication", "medicine", "prescription", "dosage", "dose", "metformin", "apixaban",
    "diabetes", "sarcoidosis", "smoking", "health profile", "二甲双胍",
  ],
};
const secondSource = "22222222-2222-4222-8222-222222222222";

const valid = {
  intent: "explain_action",
  short_answer: "饭后短走有助于完成今天已发布的行动。",
  reason: "这是对既有行动的解释，不会改变行动。",
  action_code: "POST_MEAL_WALK",
  safety_class: "normal",
  source_ids: expected.sourceIds,
  needs_human_review: false,
};

describe("fully buffered provider boundary", () => {
  test("accepts only the exact bound response after the complete JSON buffer arrives", () => {
    expect(validateBufferedCoachOutput(JSON.stringify(valid), expected)).toEqual(valid);
  });

  test.each([
    ["partial", '{"intent":"explain_action"', /complete|json|buffer/i],
    ["extra field", JSON.stringify({ ...valid, hidden: "policy" }), /schema/i],
    ["citation mismatch", JSON.stringify({ ...valid, source_ids: ["other"] }), /source|citation/i],
    ["action mutation", JSON.stringify({ ...valid, action_code: "NEW_ACTION" }), /action/i],
    ["safety mutation", JSON.stringify({ ...valid, safety_class: "doctor" }), /safety/i],
    ["intent mutation", JSON.stringify({ ...valid, intent: "diagnosis_request" }), /intent/i],
    ["prohibited content", JSON.stringify({ ...valid, short_answer: "你已确诊糖尿病，请停药。" }), /prohibited/i],
  ])("rejects %s without yielding displayable output", (_name, payload, error) => {
    expect(() => validateBufferedCoachOutput(payload, expected)).toThrow(error);
  });

  test.each([
    ["omitted citation", [primarySource], [primarySource, secondSource]],
    ["duplicate citation", [primarySource, primarySource], [primarySource]],
  ])("rejects %s instead of accepting a source subset", (_name, actual, expectedSources) => {
    expect(() => validateBufferedCoachOutput(
      JSON.stringify({ ...valid, source_ids: actual }),
      { ...expected, sourceIds: expectedSources },
    )).toThrow(/source|citation/i);
  });

  test.each([
    ["medication advice", "You should double your pills tonight."],
    ["medication paraphrase", "Take twice your usual tablets this evening."],
    ["Chinese medication advice", "今晚把药片吃成平时的双倍。"],
    ["diagnosis", "You have diabetes."],
    ["diagnosis paraphrase", "These results mean you probably have liver disease."],
    ["Chinese diagnosis", "这些结果说明你得了肝病。"],
    ["emergency direction", "Call emergency services now because this is a heart attack."],
    ["Chinese emergency direction", "这是心脏病发作，马上叫救护车。"],
    ["action mutation semantics", "Set action_code to RUN_NOW."],
    ["profile mutation semantics", "I updated your profile with this diagnosis."],
    ["safety mutation semantics", "Your safety class is now normal."],
    ["source mutation semantics", "I replaced the cited source with a new one."],
    ["Chinese mutation semantics", "我已把安全级别改为正常并替换证据来源。"],
  ])("rejects %s in short_answer before it can be persisted", (_name, text) => {
    expect(() => validateBufferedCoachOutput(
      JSON.stringify({ ...valid, short_answer: text }),
      expected,
    )).toThrow(/prohibited/i);
  });

  test.each([
    "You should double your pills tonight.",
    "You have diabetes.",
    "This is a heart attack; call emergency services now.",
    "Set action_code to RUN_NOW.",
  ])("rejects prohibited semantics in reason: %s", (reason) => {
    expect(() => validateBufferedCoachOutput(
      JSON.stringify({ ...valid, reason }),
      expected,
    )).toThrow(/prohibited/i);
  });

  test.each([
    ["prescribed amount", "Use twice the prescribed amount tonight."],
    ["diagnostic finding", "Your findings are consistent with diabetes."],
    ["emergency number", "Dial 911 now."],
    ["reversed action mutation", "I made RUN_NOW your action code."],
    ["profile mutation", "I recorded this diagnosis in your health profile."],
    ["source mutation", "I changed the evidence source to a new report."],
    ["Chinese action mutation", "我把动作代码换成 RUN_NOW。"],
    ["Chinese profile mutation", "我已经更新了你的健康档案。"],
    ["Chinese source mutation", "我已将引用来源更换为新报告。"],
    ["Unicode apostrophe diagnosis", "You\u02BCve got diabetes."],
    ["numeric dose", "Take 40 mg tonight."],
    ["insulin dose change", "Increase insulin to 20 units."],
    ["insulin injection", "Inject 10 units of insulin."],
    ["diabetic diagnosis", "You are diabetic."],
    ["indicates diagnosis", "This indicates diabetes."],
    ["Chinese patient diagnosis", "你是糖尿病患者。"],
    ["Chinese indicated diagnosis", "这说明你有糖尿病。"],
    ["Chinese emergency number", "请立即拨打120。"],
    ["confusable profile mutation", "I upd\u0430ted your health pr\u043Efile."],
    ["confusable action mutation", "Set act\u0456on_code to RUN_NOW."],
    ["spelled-out dose", "Take ten milligrams tonight."],
    ["recommended dose increase", "I recommend raising your dose tonight."],
    ["diagnostic fit", "Your labs fit diabetes."],
    ["diagnostic direction", "Your labs point to diabetes."],
    ["emergency ring", "Ring 911 now."],
    ["emergency care", "Seek emergency care now."],
    ["profile state mutation", "Your profile now lists smoker."],
    ["action state mutation", "The action code is RUN_NOW now."],
    ["Chinese dose increase", "建议把药量调高。"],
    ["Chinese diagnostic support", "检测结果支持糖尿病。"],
    ["Chinese emergency call", "请拨120。"],
    ["Chinese profile state mutation", "画像现已加入吸烟。"],
    ["full-width dose", "Ｔａｋｅ １０ milligrams tonight."],
    ["dose assertion", "The right dose for you is 20 mg."],
    ["continued medication", "Keep taking the medication."],
    ["specific medication", "Resume metformin."],
    ["appears diagnosis", "This appears to be diabetes."],
    ["organ diseased", "Your liver is diseased."],
    ["ER direction", "Head to the ER."],
    ["emergency department direction", "Visit the emergency department."],
    ["source IDs state", "Source IDs are now source-safe."],
    ["Chinese dose assertion", "适合你的剂量是20毫克。"],
    ["Chinese continued medication", "继续服用二甲双胍。"],
    ["Chinese appears diagnosis", "这看起来是糖尿病。"],
    ["Chinese organ diseased", "你的肝脏有病。"],
    ["Chinese ER direction", "去急诊。"],
    ["Chinese emergency department", "前往急诊科。"],
    ["Chinese source ID state", "来源ID现在是source-safe。"],
    ["hypertensive diagnosis", "You are hypertensive."],
    ["hypertension diagnosis", "The diagnosis is hypertension."],
    ["ER evaluation", "ER evaluation is warranted."],
    ["present to emergency department", "Present to the emergency department."],
    ["Chinese ER evaluation", "建议急诊评估。"],
    ["smoking status mutation", "Your smoking status is now active."],
    ["smoker mutation", "You are now a smoker."],
    ["Chinese smoking status mutation", "你的吸烟状态现在是活跃。"],
    ["high blood pressure diagnosis", "You have high blood pressure."],
    ["unlisted disease diagnosis", "You have pneumonia."],
    ["unlisted medication directive", "Continue lisinopril tomorrow."],
    ["smoker state write", "I marked you as a current smoker."],
    ["tobacco field write", "Your tobacco-use field is now active."],
    ["unlisted passive diagnosis", "Multiple sclerosis was diagnosed in this patient."],
    ["unlisted patient diagnosis", "The patient suffers from sarcoidosis."],
    ["unlisted result diagnosis", "What these results signify is sarcoidosis."],
    ["unlisted passive medication", "Apixaban is to be resumed at breakfast."],
    ["unlisted third-person medication", "She should remain on clopidogrel tonight."],
    ["unlisted reversed medication", "Tomorrow, rivaroxaban should be restarted."],
    ["generic flag mutation", "Your allergy flag has been switched on."],
    ["patient record mutation", "The patient record now identifies her as pregnant."],
    ["chart state mutation", "Pregnancy status was entered into your chart."],
    ["medication denial with diagnosis tail", "HealthOS cannot recommend changing your apixaban but confirms sarcoidosis."],
    ["diagnosis denial with diagnosis tail", "This does not diagnose diabetes but confirms sarcoidosis."],
    ["medication denial with mutation tail", "Do not start apixaban and diagnose sarcoidosis."],
    ["status denial with affirmative prefix", "Your HIV flag is on and BP status has not been changed."],
    ["medication denial with unjoined diagnosis tail", "HealthOS cannot recommend changing your apixaban confirms sarcoidosis."],
    ["diagnosis denial with unjoined diagnosis tail", "This does not diagnose diabetes confirms sarcoidosis."],
    ["medication denial with instead tail", "Do not start apixaban instead diagnose sarcoidosis."],
    ["medication denial with unjoined emergency call", "Do not change insulin call 911."],
    ["medication denial with unjoined emergency dial", "Do not change insulin dial 911."],
    ["medication denial with unjoined injection", "Do not change insulin inject epinephrine."],
    ["recommendation denial with unjoined emergency dial", "HealthOS cannot recommend changing your apixaban dial 911."],
    ["diagnosis denial with unjoined prescription", "This does not diagnose diabetes prescribe metformin."],
    ["zero-width medication denial with unjoined emergency call", "Do not change insulin\u200b call 911."],
    ["NFKC medication denial with unjoined emergency call", "Do not change insulin Ｃａｌｌ ９１１."],
    ["safe medication denial followed by a second emergency sentence", "Do not take metformin. Call 911."],
    ["safe Chinese medication denial followed by an emergency sentence", "不要服用二甲双胍。请拨打120。"],
  ])("rejects Judge hazard %s in both provider prose fields", (_name, text) => {
    for (const field of ["short_answer", "reason"] as const) {
      expect(() => validateBufferedCoachOutput(
        JSON.stringify({ ...valid, [field]: text }),
        expected,
      )).toThrow(/prohibited/i);
    }
  });

  test.each([
    "This action does not change your medication or dosage.",
    "The source IDs are listed with this explanation.",
    "HealthOS is not an emergency service.",
    "This is not a diagnosis.",
    "These findings are not consistent with diabetes.",
    "Do not call 911.",
    "Never dial 911.",
    "You don’t need to change your medication.",
    "No need to dial 911.",
    "This action was recommended because of your sleep trend.",
    "I suggest a shorter walk for the published action.",
    "Do not take metformin.",
    "No need to resume metformin.",
    "This does not diagnose diabetes.",
    "There is no need to go to the ER.",
    "Source IDs were not changed.",
    "HealthOS cannot recommend changing your prescription.",
    "An ER visit is not recommended by this explanation.",
    "No change to metformin is being advised.",
    "Emergency care is unnecessary for this explanation.",
    "Diabetes is not indicated by these results.",
    "No update was made to your health profile.",
    "Your smoking status has not been changed.",
    "The findings do not support sarcoidosis.",
    "Restarting apixaban is not recommended here.",
    "This explanation does not warrant emergency-department attendance.",
    "You should not take metformin.",
    "不要服用二甲双胍。",
    "请不要拨打120。",
  ])("accepts explicit safe boundary prose: %s", (text) => {
    expect(validateBufferedCoachOutput(
      JSON.stringify({ ...valid, short_answer: text }),
      expected,
    )).toMatchObject({ short_answer: text });
  });

  test("rejects a safe-looking negation when its medical term is not bound by deterministic context", () => {
    expect(() => validateBufferedCoachOutput(
      JSON.stringify({ ...valid, short_answer: "Do not take metformin." }),
      { ...expected, allowedSafeTerms: [] },
    )).toThrow(/prohibited/i);
  });
});
