# WeCom Feasibility Gate

Status: `pending`  
Allowed scope: official WeCom capabilities with synthetic identities only.

## V1 Channel Decision

- PASS: WeCom may remain an optional Beta adapter after privacy, security, identity, and delivery tests pass.
- FAIL: V1 ships with APNs and in-app Coach. Personal WeChat bridging remains outside V1.
- PENDING: no WeCom product promise, credentials, production implementation, or real-user binding.

## Mandatory Questions

1. Can the exact target consumer identity model be bound through an official capability?
2. Can the application proactively send the permitted message type and receive a verifiable outcome?
3. Are callbacks authenticated, replay-protected, tenant-scoped, and operationally observable?
4. Can users opt out and can send-time consent suppress queued messages?
5. What happens when an employee leaves, the tenant changes, or an administrator rotates?
6. Can a message open an authenticated Universal Link without exposing health content?
7. Do wrong-recipient and ambiguous-binding cases fail closed?
8. Are rate limits, content restrictions, data region, retention, and platform terms acceptable?

## Evidence Contract

Run `spikes/wecom-synthetic/protocol.json` against a separately approved sandbox. Store no credentials or real external IDs in the repository. Each required scenario records timestamp, sandbox identity labels, request/response hashes, outcome, reviewer, and evidence reference. Any required failure makes the binary result FAIL.

The channel message body is minimal and generic. Health details require authenticated in-app access and resource-level authorization.
