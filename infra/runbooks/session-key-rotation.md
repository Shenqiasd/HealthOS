# Session signing key rotation

This runbook rotates access-token signing material without storing or exposing
tokens. It does not claim Apple, APNs, KMS, or production account readiness.

## Scope and invariants

- `SESSION_SIGNING_SECRET` signs new HS256 access tokens and must contain at
  least 32 high-entropy characters supplied by the deployment secret manager.
- `SESSION_SIGNING_SECRET_PREVIOUS` is accepted for verification only. It is
  temporary and must never be used to sign a new token.
- Refresh tokens are opaque random values. Rotation of the access signing key
  does not change their one-way database hashes or refresh families.
- Never print either secret, an access token, or a refresh token in commands,
  tickets, logs, or the rotation receipt.

## Rotation procedure

1. Generate a new secret in the approved secret manager. Record its secret
   version, owner, change ticket, and rollback owner, but not its value.
2. Set `SESSION_SIGNING_SECRET_PREVIOUS` to the currently active secret and
   set `SESSION_SIGNING_SECRET` to the new secret in one deployment change.
3. Deploy all API instances. Confirm readiness and synthetic login, refresh,
   logout, and authenticated device-registration probes.
4. Keep the previous secret available for at least the configured access-token
   lifetime (currently 15 minutes) plus deployment clock-skew and rollback
   margin. Monitor authentication rejection and refresh-reuse events.
5. Remove `SESSION_SIGNING_SECRET_PREVIOUS`, redeploy, and repeat the probes.
6. Disable the old secret version in the secret manager after the rollback
   window. Attach redacted deployment, probe, and monitoring evidence to the
   change record.

## Rollback

Before step 5, restore the old secret as `SESSION_SIGNING_SECRET` and keep the
new one as `SESSION_SIGNING_SECRET_PREVIOUS`. After step 5, restore both values
and redeploy. Do not restore a secret that incident response has classified as
compromised; instead rotate again and revoke all refresh-session families.

## Emergency compromise

Remove the compromised key from both variables, deploy a new signing key, and
revoke every active refresh-session family. Existing access tokens may remain
usable only until the new deployment stops accepting the compromised key.
Coordinate user notification and incident evidence under the approved incident
response plan.
