# TODOs

## V1: WeChat bridge robot experiment

**What:** Explore a Cola/OpenClaw-style WeChat bridge robot after V0.1.

**Why:** The long-term product should feel like an AI health advisor in the user's daily chat surface, but V0.1 uses WeCom bot to reduce account and delivery risk.

**Pros:** Preserves the intended China-native interaction model and creates a path toward a richer bot-first experience.

**Cons:** If started too early, this can distract from proving the 7-day health-advisor loop.

**Context:** /plan-eng-review chose WeCom bot as V0.1's only active delivery channel. WeChat bridge remains internal lab work until V1.

**Depends on / blocked by:** V0.1 7-day beta passes, channel feasibility checklist is understood, and WeCom delivery data shows users want a deeper chat experience.

## V1: Lipid and glucose boundary user expansion

**What:** Expand beyond fatty liver, uric acid, waist/weight, and sleep recovery into lipid and glucose boundary users.

**Why:** Lipid and glucose users are valuable, but they increase medical-interpretation risk in V0.1.

**Pros:** Opens a larger metabolic-health surface once review and safety flows are proven.

**Cons:** Adds more medical nuance and reviewer burden.

**Context:** /plan-eng-review moved lipid/glucose boundary users out of V0.1. V0.1 may store lipid/glucose lab fields from original reports, but must not use them to select users or drive daily recommendations.

**Depends on / blocked by:** V0.1 beta passes, named reviewer workflow is stable, and golden cases expand from 15 to 30-50.

## V1: HealthKit background sync stabilization

**What:** Make HealthKit background sync reliable enough for a long-term daily advisor.

**Why:** V0.1 uses app-open sync plus best-effort background sync and data freshness display. Long-term, HealthOS should not depend on users opening the app every day.

**Pros:** Improves daily report timeliness and product feel.

**Cons:** iOS background behavior is uncertain and raises QA cost.

**Context:** /plan-eng-review chose app-open sync plus best-effort background sync for V0.1. Stale background data must not silently drive recommendations.

**Depends on / blocked by:** V0.1 sync metrics show enough demand for daily reports and reveal where app-open sync is insufficient.

## V1: Report Snapshot, Channel Outbox, and Rule Versioning

**What:** Upgrade V0.1's minimal audit model into full report snapshot, channel outbox, and rule versioning.

**Why:** V0.1 needs basic replayability, but not full platform infrastructure. V1 should make delivery, rules, and provenance production-grade.

**Pros:** Better incident review, rule iteration, multi-channel expansion, and auditability.

**Cons:** Building it too early turns V0.1 into platform work before demand is proven.

**Context:** V0.1 stores `profile_event`, `recommendation_snapshot`, `delivery_log`, and `feedback_event`. Full event sourcing, multi-channel outbox, and rule versioning are explicitly out of V0.1.

**Depends on / blocked by:** V0.1 generates real reviewer edits, delivery failures, and feedback data that justify the extra architecture.

## V2: Food XRAY, four scores, and visual report system

**What:** Add Food XRAY macro nutrition, four public health scores, and a polished visual report system.

**Why:** These are part of the full HealthOS vision, but they need real food photos, correction data, and a stable advice loop first.

**Pros:** Creates a richer, more differentiated long-term product.

**Cons:** Prematurely adding them would blur V0.1's learning goal and inflate implementation scope.

**Context:** V0.1 validates one daily low-risk recommendation. V1 hardens the loop. V2 can bring back Food XRAY, Daily Health Score, Recovery, Metabolic Risk, Consistency, and weekly visual reports.

**Depends on / blocked by:** V0.1/V1 evidence that users keep using the advisor, plus enough meal photos, feedback, and correction data.
