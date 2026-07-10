# HealthOS V1 Retention Schedule

Status: `pending legal/privacy and infrastructure approval`

No period below is approved yet. Engineering must represent each category as configurable policy and use the shortest operationally defensible value after review.

| Category | Proposed trigger | Proposed active retention | Deletion behavior | Approval evidence |
|---|---|---:|---|---|
| Sessions | logout, expiry, compromise | short-lived | revoke immediately; purge expired records | security owner |
| Device and APNs binding | unlink or account deletion | operational grace only | token and binding removed; audit retained separately | privacy/security owner |
| Health day revisions | account deletion | account life | purge primary records; backup expiry follows approved policy | privacy/legal owner |
| Lab and food objects | user deletion or account deletion | minimum needed for feature | object tombstone then physical deletion and provider propagation | privacy/legal owner |
| Confirmed profile facts | user correction or account deletion | versioned while account active | preserve correction audit without sensitive prior payload where possible | medical/privacy owner |
| Recommendations and actions | account deletion | sufficient for Review and safety audit | delete user payload; retain non-identifying aggregate only if approved | medical/privacy owner |
| Coach messages | thread or account deletion | configurable and visible to user | purge content and provider copies | privacy/medical owner |
| Delivery attempts | terminal delivery plus audit window | short operational window | remove provider identifiers; retain aggregate status | security/privacy owner |
| Audit and incidents | policy-defined legal/security window | pending | restrict access; separate sensitive encrypted details | legal/security owner |
| Backups | backup creation | target max 35 days, unapproved | encrypted expiry; deletion reflected after rotation | infrastructure/privacy owner |

## Required Controls

- Retention is enforced by idempotent jobs with metrics and failure alerts.
- A legal hold is explicit, scoped, authorized, and auditable; it is never inferred.
- Restore procedures must not silently resurrect deleted users.
- Provider deletion receipts are associated with the deletion request.
- Production release remains blocked until every row has an approved duration and owner.
