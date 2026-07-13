import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTelemetrySink } from "@healthos/observability";

import { WorkerTelemetry } from "./worker-telemetry";

test("worker telemetry preserves correlation while removing health and identity payloads", async () => {
  const sink = new InMemoryTelemetrySink(5);
  const telemetry = new WorkerTelemetry(sink);
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("external telemetry is forbidden in this tranche");
  };
  try {
    const event = await telemetry.record({
      eventName: "recommendation.suppressed",
      severity: "warn",
      correlationId: "00000000-0000-4000-8000-000000000021",
      attributes: {
        component: "recommendation-worker",
        status: "suppressed",
        reason_code: "kill_switch_global",
        context: {
          user_id: "synthetic-user-secret",
          health_text: "胸痛和血糖偏高",
          lab_value: 9.8,
          access_token: "secret-token",
          exception: new Error("private stack"),
        },
      },
    });
    assert.equal(event.correlation_id, "00000000-0000-4000-8000-000000000021");
    assert.equal(sink.events.length, 1);
    const serialized = JSON.stringify(sink.events[0]);
    for (const secret of ["synthetic-user-secret", "胸痛", "血糖", "9.8", "secret-token", "private stack"]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failing sink cannot change worker behavior", async () => {
  const telemetry = new WorkerTelemetry({ emit: () => { throw new Error("local sink unavailable"); } });
  await assert.doesNotReject(telemetry.record({
    eventName: "worker.completed",
    severity: "info",
    attributes: { component: "worker", status: "complete" },
  }));
});
