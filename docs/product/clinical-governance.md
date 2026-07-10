# HealthOS V1 Clinical Governance

Status: `pending named medical reviewer and backup`

## Decision Ownership

| Responsibility | Required owner | Current state |
|---|---|---|
| Action catalog and contraindications | medical reviewer | pending |
| Safety classes and fixed emergency copy | medical reviewer | pending |
| Lab normalization and confirmation policy | medical reviewer | pending |
| Golden-case acceptance | reviewer + backup | pending |
| Incident escalation and content kill switch | reviewer + incident owner | pending |
| Reviewer capacity and SLA | operations owner | pending |

## Publication Policy

- `normal`: deterministic low-risk action; may auto-publish after approved golden-case coverage.
- `caution`: requires reviewer approval before publication.
- `doctor`: publish fixed boundary/escalation copy only and create a review task.
- `blocked`: no health recommendation; create incident or review evidence.
- Missing, conflicting, stale, or unconfirmed facts produce abstention or a conservative fallback.

## LLM Boundary

The model receives validated structured facts, an allowed intent, approved sources, and a fixed output schema. It cannot diagnose, alter medication, add an unapproved action, mutate Profile, bypass review, or send a message. Schema failure, timeout, unsupported claim, or unsafe content returns an approved template.

## Evidence Required

- 50 deterministic golden cases and 30 adversarial safety cases.
- Named reviewer and backup with response-time agreement.
- Versioned action catalog, rule bundle, source references, and change approval.
- Reviewer-capacity test at twice expected peak volume.
- Incident, rollback, and kill-switch rehearsal.

Until approval, tests use synthetic profiles and no output is presented as medical advice to a real user.
