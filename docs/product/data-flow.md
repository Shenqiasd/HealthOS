# HealthOS V1 Data Flow

Status: `pending`  
Scope: architecture contract for synthetic development; production paths remain disabled until their gates pass.

## Primary Flow

```text
iOS HealthKit / confirmed user input / report upload
  -> HTTPS API with identity, consent, idempotency and correlation ID
  -> PostgreSQL immutable facts and encrypted object storage
  -> profile snapshot
  -> deterministic rules + safety policy
  -> immutable recommendation snapshot
  -> Today / Coach / Map / Review
  -> transactional outbox
  -> APNs or optional official WeCom adapter
```

## Trust Boundaries

1. The iOS device is authenticated but all inputs remain untrusted.
2. The API validates authorization, consent epoch, schema, size, source, and idempotency.
3. Object uploads require signed URLs, checksum validation, malware scanning, and short expiry.
4. Rules and safety consume confirmed canonical facts; they do not consume raw OCR text.
5. The LLM receives a minimized, validated contract and cannot publish, message, or mutate a profile.
6. Channel workers re-check consent and resource ownership at send time.
7. Admin access is role-scoped and produces an audit event.

## Environment Boundaries

| Environment | Allowed data | External providers | Release use |
|---|---|---|---|
| Local | generated synthetic fixtures | local stubs | development only |
| CI | generated synthetic fixtures | deterministic fakes | verification only |
| Staging | synthetic identities and documents | sandbox credentials after security review | Alpha rehearsal only |
| Production | real data only after all applicable gates pass | approved register entries only | external users |

## Prohibited Flows

- Real health data in Railway staging, source control, logs, screenshots, crash reports, or prompts.
- Coach writing profile state without a separate user-confirmed event.
- Channels recomputing rules or choosing health content.
- Personal WeChat automation or unofficial bridge access.
- Cross-user fallback when any channel binding is uncertain.
