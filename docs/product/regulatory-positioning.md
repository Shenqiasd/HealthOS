# HealthOS V1 Regulatory Positioning

Status: `pending qualified legal/regulatory review`

## Intended Product Position

HealthOS V1 is a wellness companion that organizes user-authorized data, explains trends, and proposes low-risk daily actions. It does not diagnose, prescribe, continuously monitor emergencies, or replace a clinician. High-risk or uncertain situations use fixed safety language and recommend appropriate professional care.

## Product Constraints

- No disease diagnosis, medication start/stop/dose change, emergency triage score, or guaranteed outcome.
- Food Risk Scan classifies visible meal risk patterns and abstains when uncertain; it does not estimate precise macros.
- Recommendations originate from approved deterministic rules and confirmed facts.
- Generative AI is limited to structured explanation and cannot expand the allowed action catalog.
- Marketing, App Store copy, onboarding, Coach, reports, and external messages must use the same boundary.

## Required Review Questions

1. Whether any V1 feature enters regulated medical-device or internet-health-service scope.
2. Applicable Mainland China personal-information, sensitive-information, algorithmic/generative-AI, MLPS, ICP, and distribution obligations.
3. Production data region and any cross-border transfer mechanism.
4. Required user notices, explicit consent, age restrictions, complaint channel, and record retention.
5. Whether OCR, AI, analytics, and messaging providers may process each proposed field.

## Gate

Synthetic implementation may continue. Real recommendations, external Beta, public claims, and production data remain blocked until a named reviewer records an approved or rejected decision with dated evidence in `preflight-gates.json`.
