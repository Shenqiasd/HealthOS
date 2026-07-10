import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilePrivacyControlStore } from "./file-privacy-control.store";

describe("FilePrivacyControlStore", () => {
  let root: string;
  let store: FilePrivacyControlStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "healthos-api-privacy-control-"));
    store = new FilePrivacyControlStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("defaults to no-send and requires a matching blocked restore run", async () => {
    await expect(store.isSendAllowed()).resolves.toBe(false);
    await expect(store.allowSends("restore-1")).rejects.toThrow(/blocked/i);
    await store.blockSends("restore-1");
    await store.allowSends("restore-1");
    await expect(store.isSendAllowed()).resolves.toBe(true);
  });

  test("keeps deletion fences idempotent and append-only", async () => {
    const input = {
      deletion_job_id: "37cb6c8f-35d3-4a62-bfff-d081a989a526",
      hash_key_version: "synthetic-v1",
      user_lookup_hash: "a".repeat(64),
    };
    const pending = await store.beginDeletionFence(input);
    const repeated = await store.beginDeletionFence({
      ...input,
      deletion_job_id: "ff364fe0-7c6d-4bcb-82fb-97c45c17320b",
    });
    expect(repeated.deletion_job_id).toBe(pending.deletion_job_id);
    await store.completeDeletionFence(
      pending.user_lookup_hash,
      pending.deletion_job_id,
    );
    await expect(store.listCompletedDeletionFences()).resolves.toMatchObject([
      { ...input, status: "completed" },
    ]);
  });
});
