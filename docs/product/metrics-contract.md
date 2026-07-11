# HealthOS V1 Metrics Contract

Status: `pending product and privacy approval`

Every release metric is versioned and calculated from pseudonymous events without health payloads. Unknown outcomes are not converted into success.

| Metric | Numerator | Denominator | Window | Exclusions | Minimum evidence |
|---|---|---|---|---|---|
| Valid HealthKit sync user ratio | users with at least one server-accepted fresh daily fact and no terminal sync error | consented active HealthKit users | rolling 14 days | revoked users; no eligible device days | 5 Alpha users, then Beta cohort |
| D1 delivery confirmation | messages with provider-confirmed terminal success | eligible D1 outbox messages | local D1 cutoff window | send-time suppression; revoked channel | report unknown separately |
| D1 read confirmation | authenticated users opening the intended D1 resource | provider-confirmed D1 deliveries | 24 hours after delivery | invalid/expired test builds | stable resource ID |
| D7 Review open | authenticated users opening their generated weekly snapshot | users with an eligible D7 snapshot | 72 hours after availability | insufficient-coverage snapshot not generated | cohort count reported |
| Feedback participation | users with at least three idempotent feedback events | users assigned at least three actions | cohort period | synthetic QA users | >= 50% target |
| Usefulness | users rating usefulness >= 4/5 | users submitting usefulness rating | end of Alpha/Beta | duplicate submission | response count shown |
| Continue intent | users answering yes | users answering the continue question | end of cohort | no response | >= 50% target |
| Major reviewer rewrite | normal recommendations requiring semantic action/safety change | reviewed normal recommendations | release cohort | spelling/style-only edits | <= 20% target |
| Unsafe delivery | delivered payloads violating approved safety policy | all delivered recommendations | continuous | none | target 0 |
| Wrong recipient | delivery authorized to a different user/resource owner | all delivery attempts | continuous | none | target 0 |
| Unauthorized access | successful resource response without valid user authorization | protected-resource requests | continuous | approved security tests separated | target 0 |

## Governance

- Event schemas contain metric version, pseudonymous user ID, cohort, timestamp, and outcome code only.
- Denominators, exclusions, timezones, and minimum event counts are fixed before each cohort.
- Dashboards distinguish missing, unknown, suppressed, failed, and confirmed outcomes.
- Metrics cannot override safety gates or justify sending more sensitive data.
