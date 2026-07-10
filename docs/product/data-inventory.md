# HealthOS V1 Data Inventory

Status: `pending`  
Decision source: `preflight-gates.json`  
Scope: synthetic-only until the privacy, region, security, and clinical gates are approved.

## Inventory

| Domain | Minimum fields | Purpose | Sensitivity | System of record | Default retention | External transfer |
|---|---|---|---|---|---|---|
| Account | opaque user ID, Apple subject hash, locale, timezone | authentication and localization | personal | PostgreSQL | account life + deletion window | none before provider approval |
| Device | device ID, encrypted APNs token, app version, last seen | sync and notification routing | personal/security | PostgreSQL | active device + 30 days | APNs token to Apple only after consent |
| Consent | document version, grant/revoke event, timestamp, source | prove lawful product behavior | sensitive governance | PostgreSQL/audit | legal owner decision required | none |
| HealthKit | day aggregate, coverage, source vector, revision hash | freshness, trends, recommendations | sensitive health | PostgreSQL | schedule pending | none before production-region approval |
| Lab report | encrypted object, hash, extracted observation, page/evidence box, confirmation state | confirmed profile facts | highly sensitive health | object storage + PostgreSQL | schedule pending | OCR only after provider approval |
| Food scan | encrypted image, risk labels, confidence, correction | meal risk guidance, not calorie estimation | health-adjacent | object storage + PostgreSQL | schedule pending | model provider only after approval |
| Profile | goals, constraints, confirmed facts, event and snapshot versions | deterministic recommendation input | sensitive health | PostgreSQL | account life + deletion window | minimized model context only after approval |
| Recommendation | canonical rule input, rule version, safety class, rendered payload, provenance | Today/Coach/Review and audit replay | sensitive health | PostgreSQL | schedule pending | no unrestricted LLM input |
| Coach | intent, constrained answer, sources, safety and model metadata | safe explanation | sensitive health | PostgreSQL | schedule pending | approved provider only |
| Channel | encrypted external ID, lookup HMAC, consent epoch, delivery result | APNs/optional WeCom delivery | sensitive linkage | PostgreSQL | unlink + audit window pending | official provider only |
| Operations | review task, admin access, incident and audit hashes | human review and incident response | sensitive operations | PostgreSQL | schedule pending | approved error/telemetry provider only |
| Product metrics | pseudonymous event, metric version, outcome bucket | Alpha/Beta release evidence | pseudonymous | approved analytics store or PostgreSQL | schedule pending | no health payload |

## Collection Rules

- Request only HealthKit types used by a visible V1 feature.
- Upload day-level aggregates and revisions by default, not every raw heart-rate sample.
- Keep report originals in encrypted object storage, never in logs or analytics.
- Push notifications and external messages contain no diagnosis, lab value, or sensitive summary.
- Every external processor must be approved in the provider register before receiving real data.
- Deletion is resumable and covers database, object storage, channel bindings, provider copies, and backups according to the approved schedule.

## Open Decisions

- Production data region and cross-border position.
- Final retention periods and legal holds.
- Approved OCR, AI, telemetry, object-storage, APNs, and optional WeCom processors.
- Whether any raw sample slice is necessary; default is no.
