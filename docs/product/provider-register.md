# External Provider Register

Status: `pending privacy and security approval`

No production provider is approved. Product names below are capability slots, not selections.

| Capability | Candidate | Fields allowed | Region | Provider retention | Training use | Subprocessors | Kill switch | State |
|---|---|---|---|---|---|---|---|---|
| iOS push | Apple APNs | opaque token, generic notification payload | pending | pending | prohibited | pending | disable channel | pending |
| Object storage | pending | encrypted report/food object and object key | pending | HealthOS policy | prohibited | pending | block upload/read | pending |
| OCR | pending | minimized report pages after consent | pending | pending | prohibited | pending | manual confirmation only | pending |
| LLM | pending | validated minimized structured context | pending | pending | prohibited | pending | template fallback | pending |
| Error tracking | pending | pseudonymous diagnostic metadata, no health payload | pending | pending | prohibited | pending | disable SDK | pending |
| Product analytics | pending or first-party | versioned pseudonymous events, no health payload | pending | pending | prohibited | pending | first-party only | pending |
| WeCom | official capability pending gate | tenant-scoped binding and generic message | pending | pending | prohibited | pending | APNs/in-app only | pending |

## Approval Requirements

Every selected provider needs a named business owner, purpose, exact fields, lawful basis, data region, retention/deletion behavior, subprocessors, training-use terms, breach contacts, access controls, contract/DPA evidence, sandbox/production separation, and tested kill switch.

Secrets live in the approved secret manager. Provider payloads and credentials never appear in source control, receipts, analytics, or ordinary application logs.
