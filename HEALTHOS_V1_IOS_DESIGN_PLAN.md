# HealthOS V1 iOS Design Plan

Version: v0.1
Date: 2026-06-29
Status: design-plan review in progress

## Scope

This document defines the V1 iOS north-star experience for HealthOS.

It does not replace the V0.1 WeCom / WeChat delivery MVP. The V0.1 product can still prove the daily advisor loop through lighter channels. This V1 iOS plan defines what the full companion app should feel like once the loop is proven.

## Product Frame

HealthOS is not a health data dashboard. It is a long-term health companion that helps the user understand one current body signal, take one small action, and see progress over time.

MoMo / 墨墨 is the emotional anchor. The user should feel that MoMo is watching patterns with them, not grading them.

## Existing Visual References

| Screen | Source |
|---|---|
| Today | `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/design-targets/today.png` |
| Coach | `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/design-targets/coach.png` |
| Map | `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/design-targets/map.png` |
| Review | `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/design-targets/review.png` |

Implementation QA source:

- `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/design-qa.md`

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-06-29 | Use a Today-first loop. | Users should not have to explore four tabs to know what to do today. Today owns the daily behavior loop. Coach, Map, and Review support Today. |
| 2026-06-30 | Define a full state matrix for all four V1 tabs. | The product must work when data is missing, stale, denied, partial, or when the user rejects the action. Beautiful success screens are not enough. |
| 2026-06-30 | Use a gentle-accountability emotional arc. | MoMo should catch failure without shame, then bring the user back to one small action. It is neither a toy nor a clinical dashboard. |
| 2026-06-30 | Give each tab its own layout grammar. | MoMo should structure the product, not become decoration repeated on every page. |

## Pass 1: Information Architecture

### Rating

Before fixes: 4/10

After fixes: 8/10

Remaining gap: the plan still needs full interaction states, safety copy, design tokens, and accessibility rules before it becomes implementation-ready.

### Primary Navigation Model

The four tabs are not equal destinations. They form a support system around one daily action.

```text
Today = What should I do today?
Coach = Can MoMo adapt or explain this?
Map = What signal caused this recommendation?
Review = What changed this week, and what next?
```

### Daily Loop

```text
User opens app
  ↓
Today shows one current action
  ├─ Complete
  │    ↓
  │  MoMo celebrates quietly
  │    ↓
  │  Progress saved for Review
  │
  ├─ Make it lighter
  │    ↓
  │  Coach asks or infers constraint
  │    ↓
  │  Today updates to a smaller action
  │
  ├─ Why this?
  │    ↓
  │  Map opens selected signal
  │    ↓
  │  User sees likely driver and returns to Today
  │
  └─ Not suitable today
       ↓
     Coach catches reason without guilt
       ↓
     Today records skipped / replaced action

End of week
  ↓
Review explains what became better, what needs attention, and next week's 1-3 actions
```

### Tab Responsibilities

| Tab | Job | First Glance | Second Glance | Third Glance |
|---|---|---|---|---|
| Today | Drive one doable action today. | Today's one action and completion/adjustment affordance. | Why this action matters. | Lightweight check-in and status. |
| Coach | Adapt, explain, and emotionally catch the user. | MoMo's current interpretation of the user's situation. | Quick replies for adjust / explain / record. | Evidence chips and free input. |
| Map | Explain body signals without becoming a dashboard. | One selected signal and its color/status. | Likely driver and confidence. | Link back to today's action. |
| Review | Turn the week into memory and next action. | One weekly conclusion. | 2-3 meaningful changes. | Share/save plus next week plan. |

### Day 1 / Day 3 / Day 7 IA

| Day | User Need | Primary Screen | Required IA |
|---|---|---|---|
| Day 1 | Trust MoMo and connect enough data. | Today | MoMo explains the first tiny action, shows why permissions matter, and avoids overwhelming setup. |
| Day 3 | Recover from friction. | Today + Coach | If the user skipped or failed actions, Today offers a lighter action and Coach normalizes adjustment. |
| Day 7 | See progress and know what next. | Review | Review shows what changed, what data was missing, and next week's 1-3 actions. |

### Information Architecture Rules

1. Today never shows more than one primary action.
2. Coach never replaces Today as the daily task surface. It adapts or explains Today.
3. Map never becomes a full metric dashboard. It explains the selected signal behind the action.
4. Review never becomes a data dump. It produces one conclusion, 2-3 evidence points, and next week's action set.
5. Every screen must support a return path to Today unless the user is explicitly reviewing the week.

## Pass 2: Interaction State Coverage

### Rating

Before fixes: 3/10

After fixes: 8.5/10

Remaining gap: safety copy, provenance rules, a11y details, and component tokens still need their own passes. This pass defines what the user sees and what they can do in each major state.

### State Philosophy

HealthOS must never punish the user for missing data, missed actions, or low motivation.

Every imperfect state must still feel like MoMo is present and useful. The app should degrade into a smaller action, a clearer explanation, or a warmer setup step, not into blank panels or technical errors.

### Global State Rules

1. Every state must show one primary next action.
2. Every state must include a short MoMo line unless the system is in a critical system error.
3. Data-dependent advice must show freshness or uncertainty when available.
4. If confidence is low, the UI must ask one clarifying question or offer a lighter generic action.
5. If a recommendation is rejected, the product records friction without guilt language.
6. Weekly Review can be partial. It must not pretend a full week exists when data coverage is weak.
7. Permission-denied screens must explain user value before requesting access again.
8. No state should use hospital-style alarm language unless the situation is explicitly high risk.

### Today State Matrix

| State | What User Sees | MoMo Line | Primary Action | Secondary Action |
|---|---|---|---|---|
| Loading | MoMo holding today's note, soft skeleton for action panel. | "我先看一下今天的信号。" | None until loaded. | None. |
| Empty / first launch | One tiny starter task that does not require health data, plus Apple Health setup. | "先不用全都填好，今天从一件小事开始。" | Connect Apple Health. | Try a starter action. |
| Partial data | One safe action based on available data, with a small "data incomplete" tag. | "数据还不全，但这件事今天可以做。" | Start action. | Complete setup. |
| Error | Warm recovery panel, no raw error text. | "刚才有个地方没读到，我不会乱给建议。" | Retry. | Use a simple fallback action. |
| Success | Action marked complete, MoMo quietly celebrates. | "收到，这个小改变我记下来了。" | View progress. | Ask why it helped. |
| Permission denied | MoMo explains why Health data helps, without blocking the app. | "没有权限也能继续，只是我会少看见一些信号。" | Enable Apple Health. | Continue with manual check-in. |
| Stale data | Current task downgraded or paused with freshness label. | "这条数据有点旧，我先不给你下重判断。" | Refresh data. | Do a low-risk action. |
| Task rejected | User sees reason choices: no time, tired, uncomfortable, weather, not now. | "没关系，今天可以换轻一点。" | Make it lighter. | Skip today without guilt. |

### Coach State Matrix

| State | What User Sees | MoMo Line | Primary Action | Secondary Action |
|---|---|---|---|---|
| Loading | Chat room visible, MoMo thinking indicator, evidence chips skeleton. | "我在把今天的信号放一起看。" | None until response. | None. |
| Empty / first launch | Suggested prompts: explain today's action, set limitation, tell MoMo your goal. | "你可以先告诉我，最近最想改善什么。" | Pick a prompt. | Type freely. |
| Partial data | Coach answer includes "based on available data" and asks one clarifying question. | "我还缺一点信息，所以先保守一点。" | Answer question. | Use lighter task. |
| Error | Chat response fails gracefully, keeps user's draft. | "这句我没说好，再试一次。" | Regenerate. | Send shorter question. |
| Success | Coach returns adjusted plan and sends it back to Today. | "那今天就换成这个版本。" | Update Today action. | Ask why. |
| Permission denied | Coach explains what it cannot see and offers manual check-in. | "我现在看不到睡眠和步数，你可以手动告诉我一点。" | Manual check-in. | Enable Apple Health. |
| Stale data | Coach uses cautious language and highlights stale sources. | "我看到的是旧数据，所以只给轻建议。" | Refresh data. | Continue cautiously. |
| Task rejected | Coach normalizes rejection and captures friction reason. | "不是失败，是今天条件不一样。" | Choose reason. | Create smaller action. |

### Map State Matrix

| State | What User Sees | MoMo Line | Primary Action | Secondary Action |
|---|---|---|---|---|
| Loading | Soft parchment map with nodes warming in one by one. | "我在把身体信号连起来。" | None until loaded. | None. |
| Empty / first launch | Map with locked/faded islands explaining needed inputs. | "等有一点数据，这张地图会慢慢亮起来。" | Connect data. | Learn what signals mean. |
| Partial data | Available nodes active, missing nodes muted with reason. | "现在只有几块地图是亮的。" | View active signal. | Add missing input. |
| Error | Map stays calm, selected signal drawer says unavailable. | "这块信号暂时读不到，我不会硬解释。" | Retry. | Back to Today. |
| Success | Selected signal drawer shows signal, change, likely driver, confidence, Today link. | "这个小波动，可能和这里有关。" | Use today's action. | Ask Coach. |
| Permission denied | Health-data-dependent islands faded, report/manual islands may remain. | "少了权限，地图会少几盏灯。" | Enable Apple Health. | Manual check-in. |
| Stale data | Nodes show stale badge and confidence lowered. | "这不是今天最新的图，我先标成旧信号。" | Refresh. | View last known signal. |
| Task rejected | Map explains why a lighter action still relates to selected signal. | "换轻一点，也是在照顾这个信号。" | Accept lighter action. | Ask Coach. |

### Review State Matrix

| State | What User Sees | MoMo Line | Primary Action | Secondary Action |
|---|---|---|---|---|
| Loading | MoMo preparing report, report panel skeleton, data coverage indicator. | "我在帮你把这一周看完。" | None until loaded. | None. |
| Empty / first launch | No weekly report yet, shows how to create first review. | "还不到复盘的时候，我们先攒几天证据。" | Start first week. | See sample report. |
| Partial data | Partial report with coverage label, only claims supported by data. | "这周我只看到了部分信号，所以只说有把握的。" | View partial report. | Fill missing check-ins. |
| Error | Report generation unavailable, no fake conclusion. | "这次报告没生成好，我不想乱总结。" | Retry. | Save current notes. |
| Success | Full report: one conclusion, 2-3 evidence rows, next week's 1-3 actions. | "我帮你看完这一周了。" | Save/share report. | Set next week actions. |
| Permission denied | Review explains what cannot be included without permission. | "没有这些数据，周报会少一部分身体信号。" | Enable Apple Health. | Generate manual-only review. |
| Stale data | Report shows date range and data freshness warning. | "这份复盘里有些数据不是最新的。" | Refresh before report. | Continue with stale badge. |
| Task rejected | Review includes skipped/replaced actions neutrally. | "这周你调整过几次，这也算重要记录。" | See friction patterns. | Plan lighter week. |

### Required Cross-Screen State Flows

#### Apple Health Permission Denied

```text
Today permission denied
  ↓
Primary: Enable Apple Health
Secondary: Manual check-in
  ↓
Coach can still ask one manual question
  ↓
Map shows fewer active signals
  ↓
Review can generate manual-only or partial report
```

#### Data Insufficient

```text
Today shows safe starter action
  ↓
Map explains which signals are missing
  ↓
Coach asks for one missing input
  ↓
Review labels the week as partial
```

#### Task Rejected

```text
Today: "Not suitable today"
  ↓
Coach captures reason without shame
  ↓
Today replaces action with lighter version or records skip
  ↓
Review summarizes friction pattern, not failure
```

#### Weekly Report Unavailable

```text
Review cannot generate full report
  ↓
Show coverage reason
  ↓
Offer partial report or fill missing check-ins
  ↓
Never invent a weekly conclusion
```

### Minimum State Acceptance Criteria

Before implementation is considered design-ready:

- Every tab must have visible designs or wire specs for the eight states above.
- Every non-success state must include one next action.
- Every health-data-dependent state must show data freshness or confidence when the claim could be misread as medical certainty.
- Every permission state must allow the user to continue in a reduced mode.
- Every rejected action must produce either a lighter action or a neutral skip record.

## Pass 3: User Journey & Emotional Arc

### Rating

Before fixes: 4/10

After fixes: 8.5/10

Remaining gap: the plan still needs medical safety wording, design tokens, motion rules, and privacy/share rules. This pass defines the emotional journey.

### Emotional Positioning

HealthOS should feel like gentle accountability.

MoMo does not scold. MoMo also does not let the user drift forever. The emotional promise is:

```text
I saw what happened.
It is not a moral failure.
Let's make the next step smaller and do it today.
```

### What MoMo Is

| Role | Meaning | UI Behavior |
|---|---|---|
| Warm observer | MoMo notices patterns without making the user feel watched. | Uses calm signal language: "我看到一个小波动" instead of "你又..." |
| Small-action coach | MoMo turns health signals into one doable action. | Today always ends in one action, not a lecture. |
| Friction catcher | MoMo treats skipped actions as input, not failure. | Coach asks why and offers a lighter path. |
| Memory keeper | MoMo remembers the week and turns it into a review. | Review names progress and friction neutrally. |

### What MoMo Is Not

| Not This | Why |
|---|---|
| A doctor | The product must not imply diagnosis or treatment. |
| A gamified pet only | Cute without accountability will not change behavior. |
| A strict fitness coach | Shame breaks trust and retention. |
| A dashboard narrator | Repeating metrics is not advice. |

### 7-Day Emotional Storyboard

| Step | User Does | User Feels | MoMo / UI Response | Product Goal |
|---|---|---|---|---|
| Day 0: first open | Opens app after seeing the companion concept. | Curious, skeptical. | Today shows MoMo, one tiny starter action, and a gentle Apple Health prompt. | Build trust before asking for too much data. |
| Day 1: first action | Sees the first daily recommendation. | "Can I actually do this?" | Today explains one action. Coach can answer "why this?" Map shows the one related signal. | Convert curiosity into one completed action. |
| Day 2: imperfect data | App has partial or stale data. | Slight uncertainty. | MoMo says it will stay conservative and shows a low-risk action. | Prove the app does not hallucinate confidence. |
| Day 3: friction | User skips or rejects an action. | Guilt, resistance, or annoyance. | Coach says "不是失败，是今天条件不一样" and offers a lighter action. | Keep the user in the loop after failure. |
| Day 4-5: pattern forming | User has completed or adjusted a few actions. | Quiet momentum. | Today references prior action gently. Map shows one improving or stable signal. | Make consistency visible without turning it into a scoreboard. |
| Day 6: anticipation | User is close to a weekly review. | Wants to know if this mattered. | Review preview says what can be summarized and what is missing. | Set up the report honestly. |
| Day 7: weekly review | Opens Review. | Wants meaning, not raw data. | Review gives one conclusion, 2-3 evidence points, and next week's 1-3 actions. | Turn the week into memory and next commitment. |

### Time-Horizon Design

| Horizon | User Question | Design Answer |
|---|---|---|
| First 5 seconds | "What is this and should I trust it?" | MoMo is the anchor. Today shows one action, not a dashboard. |
| First 5 minutes | "Can it help me today?" | User can complete, lighten, reject, or ask why without leaving the loop. |
| First 5 weeks | "Does it understand my patterns?" | Review remembers progress, friction, missing data, and repeats the next small action set. |

### Tone Rules

| Situation | Use This | Avoid This |
|---|---|---|
| User completes action | "收到，这个小改变我记下来了。" | "太棒了！你打败了昨天的自己！" |
| User skips action | "没关系，今天可以换轻一点。" | "你今天没有完成目标。" |
| Data is stale | "这条数据有点旧，我先不给你下重判断。" | "数据异常，无法分析。" |
| Signal worsens | "我看到一个需要留意的小波动。" | "你的风险升高了。" |
| Weekly review | "这周身体更稳了。下周我们守住这 2 件事。" | "综合评分提升 8.2%，请继续保持。" |

### Emotional Arc Rules

1. MoMo always responds to friction before giving another task.
2. The app must distinguish "not enough data" from "bad outcome."
3. Completion feedback should be quiet, not dopamine casino.
4. Failure feedback should create a smaller next step within one tap.
5. Review should name both progress and missing data. Honesty builds trust.
6. Coach should never make the user feel that more chatting is the goal. Chat exists to return the user to a doable action.
7. Map should reduce anxiety by explaining one signal, not increase anxiety by exposing every metric.

### Journey Acceptance Criteria

Before implementation is design-ready:

- Day 1, Day 3, and Day 7 must each have a defined primary screen, MoMo line, user action, and fallback.
- Every skipped action must produce neutral language and a smaller path.
- Review must include friction as useful context, not failure.
- Coach must be able to say "I don't know enough yet" warmly.
- The product should feel more useful after a missed day, not less.

## Pass 4: AI Slop Risk

### Rating

Before fixes: 6/10

After fixes: 8.5/10

Remaining gap: implementation still needs component specs and design tokens. This pass defines anti-template rules so the product does not collapse into repeated cute dashboards.

### Core Risk

The current visual direction is strong. The risk is repetition.

If every future screen becomes:

```text
large MoMo hero
  ↓
speech bubble
  ↓
rounded glass panel
  ↓
bottom nav
```

the app will feel generated by page template, not designed around user intent. MoMo must be part of the product structure, not a decorative mascot pasted onto every state.

### Product Classifier

HealthOS V1 iOS is an app UI, not a marketing landing page and not a dashboard.

It should use:

- Calm surface hierarchy
- Strong companion imagery
- Dense but readable health context
- Minimal chrome
- One accent color at a time
- Utility language wrapped in warmth

It should avoid:

- Dashboard mosaics
- Repeating card stacks
- Metric walls
- Decorative icon grids
- Centered hero copy on every screen
- Hospital-report visual language
- Fitness-app achievement hype

### Tab Layout Grammar

| Tab | Layout Grammar | MoMo Role | Allowed Surfaces | Forbidden Pattern |
|---|---|---|---|---|
| Today | Action panel | MoMo introduces or reacts to one daily action. | One primary action module, small check-in chips, minimal progress affordance. | Multiple recommendations, score grids, repeated report rows. |
| Coach | Room and conversation | MoMo is present as a conversational companion. | Chat bubbles, quick replies, evidence chips, input composer. | Big report cards, generic FAQ list, chatbot wall of text. |
| Map | Exploratory canvas | MoMo guides attention to one signal. | Spatial map, signal nodes, selected drawer, one back-link to Today. | Metric dashboard, chart wall, all signals equally emphasized. |
| Review | Report magazine | MoMo presents memory and weekly meaning. | Weekly conclusion, 2-3 evidence rows, share/save area, next actions. | Daily task controls, generic feed, full medical report dump. |

### Screen-Specific Anti-Slop Rules

#### Today

Today must feel like a single doable moment.

Rules:

1. One primary action only.
2. One completion path and one adjustment path must be visible.
3. MoMo can be large only if the action is still visually dominant within the lower half.
4. No charts on Today unless they explain today's one action.
5. No more than two secondary chips above the fold.

#### Coach

Coach must feel like a room, not a generic chatbot.

Rules:

1. Chat exists to adapt Today, not to become the whole product.
2. Every AI answer must show evidence chips or a confidence boundary when giving health advice.
3. Quick replies are verbs, not categories.
4. Long explanations must collapse into "why" detail, with a short answer first.
5. MoMo should appear as a presence, not as a giant hero repeated from Today.

#### Map

Map must explain one signal at a time.

Rules:

1. One selected signal owns the screen.
2. Nodes can be tactile and visual, but the selected drawer must translate them into plain language.
3. Every signal explanation must include likely driver, confidence, and link back to Today.
4. Avoid showing all metrics equally.
5. No red emergency color unless the product is using a true high-risk pathway.

#### Review

Review must feel like a weekly memory artifact.

Rules:

1. One weekly conclusion at the top.
2. 2-3 evidence rows maximum before the share/save area.
3. Missing data must be stated as part of the report, not hidden.
4. Share output must have privacy variants.
5. Review should not include daily task controls except next-week actions.

### Card Usage Rules

Cards are allowed only when the card is the interaction or artifact.

| Allowed Card | Why It Earns The Surface |
|---|---|
| Today action module | It is the daily task object. |
| Coach chat bubble | It is a conversation object. |
| Map selected signal drawer | It is the current map object. |
| Review report panel | It is the weekly artifact. |
| Share preview | It is the export object. |

Everything else should use spacing, type, or light dividers before becoming a card.

### MoMo Repetition Rules

1. MoMo may appear large on Today and Review.
2. Coach should use MoMo as a room-scale companion, not the same centered hero pose.
3. Map should use MoMo as a guide, smaller than the selected signal.
4. Empty states can use MoMo, but each empty state needs a different emotional pose.
5. MoMo speech bubbles should be used sparingly. If every screen has one, none of them matter.

### Copy Anti-Slop Rules

Replace generic wellness copy with specific health-companion language.

| Avoid | Use |
|---|---|
| "Take control of your health" | "今天先守住饭后 12 分钟。" |
| "Your personalized insights" | "这条建议来自昨晚睡眠和今天步数。" |
| "Unlock a better you" | "先把这件事做小一点。" |
| "Health score improved" | "这周睡眠更早，饭后散步多了 3 次。" |
| "Stay motivated" | "没做到也记下来，我们看原因。" |

### Motion Rules

Motion must improve hierarchy, not decorate the app.

Allowed:

- MoMo subtle breathing or greeting on first open.
- Today completion response.
- Coach message arrival.
- Map focus transition from node to drawer.
- Review report reveal.

Required reduced-motion behavior:

- Replace motion with opacity or instant state change.
- Never use motion as the only way to communicate success, risk, or data freshness.

### AI Slop Acceptance Criteria

Before implementation is design-ready:

- Every new screen must declare which tab grammar it belongs to.
- No new screen may start with a generic hero plus three cards.
- No new screen may reuse the Review weekly-summary structure unless it is a weekly or monthly report.
- No card may exist without a named interaction or artifact purpose.
- MoMo placement must explain the screen's job.
- The product must still make sense if decorative shadows are reduced by 50%.

## Not In Scope For This Plan Pass

| Item | Rationale |
|---|---|
| Full V0 WeChat / WeCom UX | This file defines the V1 iOS north-star. WeChat remains a channel strategy and V0 delivery path. |
| Food XRAY full flow | Important for V2 depth, but the current review is about the 7-day companion loop. |
| Full medical report parser UI | Needed later. Current plan only defines how missing or available report data affects the iOS loop. |

## What Already Exists

- MoMo plush visual identity and four high-fidelity iOS source screens.
- Prototype instructions in `/Users/pete/Documents/HealthOS/healthos-v1-ios-prototype/AGENTS.md`.
- QA evidence showing the current prototype matches the source screens.
- Deferred V1/V2 product work in `/Users/pete/Documents/HealthOS/TODOS.md`.
