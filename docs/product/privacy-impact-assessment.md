# Privacy Impact Assessment

Status: `pending legal/privacy review`

## Processing Summary

HealthOS combines user-authorized HealthKit aggregates, confirmed lab facts, goals, action feedback, and optional food-risk images to produce deterministic daily actions and weekly summaries. The product is not monitored in real time and is not an emergency service.

## High-Risk Processing

| Risk | Default control | Evidence required before real users |
|---|---|---|
| Health and lab data disclosure | field minimization, encryption, private networking, resource authorization | architecture and penetration review |
| Wrong-recipient notification | tenant-scoped binding, consent epoch, send-time authorization, no sensitive push body | channel E2E with zero cross-user delivery |
| AI secondary use | provider contract prohibits training/retention unless explicitly approved | signed provider terms and kill switch |
| Inaccurate health guidance | confirmed facts, deterministic rules, safety policy, fixed fallback, reviewer queue | medical approval and golden cases |
| Opaque automated decision | provenance, rule version, evidence and user-facing explanation | explainability review |
| Over-collection | feature-linked permissions and day aggregates | data inventory review |
| Failed deletion/export | resumable state machine, provider propagation, user-visible status | live drill and audit receipt |
| Cross-border transfer | production region gate and field-level provider review | named legal decision |

## User Rights Contract

- Consent is versioned, revocable, and checked at use and send time.
- Export covers account, confirmed facts, recommendations, actions, Coach records, reviews, and channel state in a documented format.
- Deletion is in-app, resumable, and reports processing/completion without requiring support contact.
- A user can unlink a device or channel and disable each optional data source independently.

## Current Decision

No real health data may enter any HealthOS environment. Approval requires a named legal/privacy owner, production-region decision, retention approval, provider register, consent copy, export/deletion design, and threat-model acceptance.
