import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ChannelDeliveryDispatcher } from "./channel-delivery-dispatcher";
import { ChannelDeliveryWorker } from "./channel-delivery-worker";
import { createWorkerApplication } from "../../main";

test("runs reconcile, enqueue, and bounded delivery in order", async () => {
  const calls: string[] = [];
  const database = {
    channelOutbox: {
      findMany: async () => [{ id: "one" }, { id: "two" }],
    },
  };
  const worker = {
    reconcileExpiredLeases: async () => { calls.push("reconcile"); return 0; },
    enqueueDueSchedules: async () => { calls.push("enqueue"); return 0; },
    deliverOne: async (id: string) => { calls.push(`deliver:${id}`); return "sent" as const; },
  };
  const dispatcher = new ChannelDeliveryDispatcher(
    database as never,
    worker as never,
    { enabled: true, pollMilliseconds: 60_000 },
  );

  assert.equal(await dispatcher.runOnce(new Date("2026-07-13T00:00:00.000Z")), 2);
  assert.deepEqual(calls, ["reconcile", "enqueue", "deliver:one", "deliver:two"]);
});

test("does no work when the dispatcher is disabled", async () => {
  const database = new Proxy({}, {
    get() { throw new Error("disabled dispatcher touched the database"); },
  });
  const worker = new Proxy({}, {
    get() { throw new Error("disabled dispatcher touched the worker"); },
  });
  const dispatcher = new ChannelDeliveryDispatcher(
    database as never,
    worker as never,
    { enabled: false, pollMilliseconds: 60_000 },
  );

  assert.equal(await dispatcher.runOnce(), 0);
});

test("registers the synthetic-only worker and dispatcher in the real worker runtime", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const app = await createWorkerApplication();
  try {
    assert.ok(app.get(ChannelDeliveryWorker));
    assert.ok(app.get(ChannelDeliveryDispatcher));
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("production runtime cannot execute the synthetic channel worker directly", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMode = process.env.HEALTHOS_CHANNEL_MODE;
  const previousDatabase = process.env.DATABASE_URL;
  process.env.NODE_ENV = "production";
  process.env.HEALTHOS_CHANNEL_MODE = "synthetic";
  process.env.DATABASE_URL = "postgresql://healthos@127.0.0.1:1/disabled";
  const app = await createWorkerApplication();
  try {
    const worker = app.get(ChannelDeliveryWorker);
    const dispatcher = app.get(ChannelDeliveryDispatcher);
    assert.equal(await dispatcher.runOnce(), 0);
    assert.equal(await worker.enqueueDueSchedules(new Date()), 0);
    assert.equal(await worker.reconcileExpiredLeases(new Date()), 0);
    assert.equal(await worker.deliverOne(randomUUID()), "not_claimed");
  } finally {
    await app.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMode === undefined) delete process.env.HEALTHOS_CHANNEL_MODE;
    else process.env.HEALTHOS_CHANNEL_MODE = previousMode;
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
  }
});
