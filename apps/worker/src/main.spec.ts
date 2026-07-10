import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerApplication } from "./main";
import { WorkerModule } from "./worker.module";

test("worker boots without registering feature jobs", async () => {
  const app = await createWorkerApplication();

  assert.ok(app.get(WorkerModule));
  await app.close();
});
