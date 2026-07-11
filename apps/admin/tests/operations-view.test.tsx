import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OperationsQueueContent } from "../components/operations-queue-content";
import { loadReviewQueue } from "../lib/api/operations";

test("fails closed without a server-side administrator session", async () => {
  const result = await loadReviewQueue({});
  assert.deepEqual(result, { kind: "unavailable" });
});

test("renders dense queue, empty, error, and unavailable states without health detail", () => {
  const html = renderToStaticMarkup(<OperationsQueueContent state={{
    kind: "ready",
    items: [{
      id: "11111111-1111-4111-8111-111111111111", task_type: "recommendation_triage",
      priority: "high", status: "pending", assignee_id: null, assignee_label: null, sla_at: "2026-07-11T10:00:00.000Z", version: 1,
    }],
    next_cursor: null,
  }} />);
  assert.match(html, /recommendation_triage/);
  assert.match(html, /Unassigned/);
  assert.doesNotMatch(html, /raw_value|canonical|health fact|ciphertext/i);
  assert.match(renderToStaticMarkup(<OperationsQueueContent state={{ kind: "empty" }} />), /No review work/);
  assert.match(renderToStaticMarkup(<OperationsQueueContent state={{ kind: "error" }} />), /could not be loaded/);
  assert.match(renderToStaticMarkup(<OperationsQueueContent state={{ kind: "unavailable" }} />), /administrator session is not configured/i);
});
