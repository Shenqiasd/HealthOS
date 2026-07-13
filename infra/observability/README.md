# Observability foundation

These files define provider-neutral metric, SLO, and alert contracts for local
synthetic validation. They do not configure a production exporter, endpoint,
credential, pager, dashboard account, or named incident authority.

Every implementation must preserve one validated `correlation_id` and emit only
allowlisted codes, states, counts, and bounded durations. Health text, lab
values, user or channel identifiers, tokens, request bodies, exception messages,
and stack traces are prohibited.

Before production use, Task 22 still requires an approved OpenTelemetry backend,
live dashboards and alerts, provider-outage evidence, metric contract approval,
named owners, notification paths, retention, access control, and data-region
decisions.
