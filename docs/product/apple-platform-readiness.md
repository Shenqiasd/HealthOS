# Apple Platform Readiness

Status: `pending Apple release owner`

## Required Accounts And Ownership

- Apple Developer organization/team and legal account holder.
- App Store Connect app, bundle ID, signing and release owners.
- HealthKit entitlement and purpose-string owner.
- TestFlight internal/external testing owner and reviewer contact.
- Mainland China distribution and compliance-material owner.

## Engineering Checklist

| Area | Required evidence | State |
|---|---|---|
| Sign in with Apple | capability, key rotation, account-link and deletion tests | pending |
| HealthKit | least-privilege read types, grouped purpose copy, revocation and no-data states | pending |
| Privacy manifest | collected-data declarations, required-reason APIs, SDK manifests | pending |
| App Privacy | field-by-field answers aligned with inventory and providers | pending |
| Export compliance | encryption declaration and owner decision | pending |
| In-app deletion | complete workflow without support dependency | pending |
| TestFlight | build signing, external review metadata, synthetic test account | pending |
| Accessibility | Dynamic Type, VoiceOver labels, contrast, Reduce Motion | pending |
| Background behavior | BGTask and observer behavior documented as best effort | pending |

## Platform Claims

HealthOS must never imply that HealthKit background delivery is guaranteed. A foreground sync is the reliable path, and the UI displays data freshness and recovery state. HealthKit data is not used for advertising or sold.

Native project scaffolding may start after an owner is identified, but device signing, TestFlight, and release remain blocked until the listed evidence is recorded.
