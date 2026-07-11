# ADR 0001: Modular Monolith

- Status: Accepted
- Date: 2026-07-10

## Context

HealthOS V1 must keep identity, consent, health facts, profile snapshots, deterministic rules, safety, publication, delivery, and audit consistent with a small team. The main risks are safety and transaction boundaries, not independent service scaling.

## Decision

Use one TypeScript API, one independently deployed worker process from the same codebase, one PostgreSQL source of truth, encrypted S3-compatible object storage, a native SwiftUI app, and a Next.js operations console. Use internal module APIs and domain events. Durable asynchronous work uses a transactional PostgreSQL outbox/inbox with leases.

OpenAPI owns client/server contracts. Rules and safety own health decisions; an LLM adapter may only produce a validated explanation. Channels only deliver immutable published snapshots.

## Consequences

- Cross-module invariants can use one database transaction and audit trail.
- Deployments and local development remain understandable to a small team.
- Module ownership and tests must prevent direct cross-boundary access.
- A service may be extracted only after measured scaling, isolation, or ownership pressure justifies the additional failure modes.

## Reversal Criteria

Consider extraction when a module requires independent scaling by at least an order of magnitude, a separate security boundary, a different availability target, or a stable dedicated team. Any extraction requires an outbox-compatible migration and replay evidence.
