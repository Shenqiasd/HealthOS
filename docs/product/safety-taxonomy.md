# HealthOS V1 Safety Taxonomy

Status: `draft_unapproved`

This engineering artifact encodes deterministic product boundaries for
synthetic testing. It is not medical approval, diagnosis, treatment guidance,
or permission to expose recommendations to real users. A named medical reviewer
and a different technical approver must approve a versioned bundle before any
publication workflow may use it.

## Decision Order

1. Validate the profile snapshot and current data state.
2. Apply eligibility and acute-symptom gates.
3. Select at most one allowlisted risk area from trusted structured signals.
4. Select at most one action from the versioned catalog.
5. Apply contraindication, rejection, lighter-variant, and swap rules.
6. Emit structured provenance and one explicit outcome.

Untrusted text may be transported for adversarial testing but is never consulted
by the decision engine. Raw lab values and diagnostic thresholds are outside
this draft package; upstream systems must provide an approved, confirmed
structured signal.

## Outcomes

| Outcome | Safety class | Product behavior |
|---|---|---|
| `action` | `normal` | One unchanged allowlisted low-risk action. Still requires the active release review policy. |
| `action` | `caution` | One action adjusted for contraindication or rejection. Must not silently auto-publish. |
| `insufficient_data` | `caution` | No action. Explain missing, stale, conflicting, absent eligible signals, or the lack of an acceptable catalog substitute. |
| `doctor` | `doctor` | No health action. Use fixed boundary copy and create the later review/escalation work item. |
| `blocked` | `blocked` | No recommendation. Acute/high-risk path uses fixed safety handling and never an LLM-generated response. |

## Eligibility Gates

The draft engine returns `doctor` before action selection for minors, pregnancy
or trying to conceive, serious declared conditions, diabetes treatment,
medication that affects advice, or eating-disorder risk. Acute symptoms return
`blocked`. These gates deliberately abstain; they do not infer a condition.

Missing, stale, and conflicting data return `insufficient_data`. Malformed,
incomplete, extra, or unsupported runtime fields, including unknown signal
keys, fail closed as `blocked` with `INVALID_INPUT`. Mobility limitation prevents
the walk action and selects an allowlisted non-mobility swap with `caution` only
when that substitute is neither rejected nor contraindicated.

## Action Catalog Contract

Every action has a stable code, duration, difficulty, contraindication tags,
optional lighter variant, swap family, and localization copy key. The current
catalog is intentionally small and remains `draft_unapproved`:

- `SLEEP_WIND_DOWN`
- `SLEEP_WIND_DOWN_LIGHT`
- `POST_MEAL_WALK`
- `SUGARY_DRINK_SWAP`

Actions cannot alter medication, diagnose, claim treatment, or bypass a gate.
Rejecting an action may produce an independently revalidated lighter variant or
catalog swap. If none is acceptable, the engine returns
`insufficient_data / NO_ACCEPTABLE_ACTION`; it never asks generative AI to
invent a replacement.

## Bundle Approval

Bundle states are `draft_unapproved`, `approval_pending`, and
`approved_not_published`. There is deliberately no `published` state in this
Task 11 package. Technical and medical approvals require distinct non-empty
actors and valid timestamps. Task 12 owns persistence and publication, and must
recheck both approvals transactionally. In this package, bundles and approvals
are frozen module-created instances, and each approval is bound to the SHA-256
identity of the exact bundle version and content hash. Reconstructed, altered,
or forged plain objects are not publishable.

## Evaluation Evidence

The checked-in synthetic corpus contains exactly 50 golden and 30 adversarial
cases. It covers the four risk areas, missing/stale/conflicting data, every
eligibility gate, acute symptoms, mobility adjustments, action rejection,
unknown signals, and prompt-like untrusted text. Release requires all 80 cases
and 100 percent branch coverage of the safety-critical policy modules.
