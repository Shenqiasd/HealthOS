# ADR 0002: Production Data Region

- Status: Proposed, blocked on `production_data_region`
- Date: 2026-07-10

## Context

HealthOS expects Mainland China users and processes sensitive health information. Company主体、ICP/MLPS applicability, distribution, provider contracts, cross-border transfers, subprocessors, and deletion obligations have not been approved by a named legal/privacy owner.

## Current Engineering Decision

Local, CI, and staging environments are synthetic-only. The Terraform baseline is provider-neutral and creates no production cloud resource. Railway must not receive real health data or re-identifiable report documents.

Tencent Cloud in Mainland China is the technical candidate described by the design, not an approved production decision. No engineer may convert this candidate into production infrastructure before `docs/product/preflight-gates.json` records a dated approval with owner and evidence.

## Approval Inputs

- company and distribution model;
- applicable Mainland China filing and security obligations;
- field-level data map and retention schedule;
- OCR, AI, telemetry, storage, messaging, and support provider regions;
- cross-border assessment and contractual controls;
- incident, backup, restore, export, and deletion ownership.

## Reversal Criteria

If legal, platform, operational, latency, or provider evidence rejects the Mainland candidate, write a superseding ADR before real users enter. Migration must include encryption, audit continuity, object relocation, backup restore, deletion reconciliation, and rollback evidence.
