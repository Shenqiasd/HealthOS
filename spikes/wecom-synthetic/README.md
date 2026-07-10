# WeCom Synthetic Feasibility Spike

This directory defines the official WeCom V1 feasibility experiment. It contains no credentials, real enterprise identifiers, real users, or health data.

## Execution

1. Obtain separate approval for a sandbox enterprise, application, administrator, and synthetic identity model.
2. Copy `result-template.json` outside source control for each run.
3. Execute every required scenario in `protocol.json` with generic message content.
4. Record redacted request/response hashes and external evidence references, never tokens or external IDs.
5. A reviewer signs the result. Every required scenario must pass for the final binary result to be PASS.
6. Update `docs/product/preflight-gates.json` only after the evidence is reviewed.

If the result is FAIL, V1 remains APNs + in-app Coach. Personal WeChat automation is not a fallback.
