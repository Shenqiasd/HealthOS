import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  DeletionFence,
  PrivacyControlStore,
} from "@healthos/contracts";

interface SendGateEntry {
  restore_run_id: string;
  status: "blocked" | "allowed";
  recorded_at: string;
}

export class FilePrivacyControlStore implements PrivacyControlStore {
  constructor(private readonly root: string) {}

  async beginDeletionFence(
    input: Omit<DeletionFence, "status" | "created_at">,
  ): Promise<DeletionFence> {
    this.assertHash(input.user_lookup_hash);
    const path = this.fencePath(input.user_lookup_hash);
    await mkdir(join(this.root, "deletion-fences"), { recursive: true, mode: 0o700 });
    const fence: DeletionFence = {
      ...input,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(fence)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return fence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readFence(path);
    }
  }

  async completeDeletionFence(
    userLookupHash: string,
    deletionJobId: string,
  ): Promise<DeletionFence> {
    this.assertHash(userLookupHash);
    const path = this.fencePath(userLookupHash);
    const current = await this.readFence(path);
    if (current.deletion_job_id !== deletionJobId) {
      throw new Error("Deletion fence belongs to another job");
    }
    if (current.status === "completed") return current;
    const completed: DeletionFence = {
      ...current,
      status: "completed",
      completed_at: new Date().toISOString(),
    };
    await this.appendDurably(path, `${JSON.stringify(completed)}\n`);
    return completed;
  }

  async listCompletedDeletionFences(): Promise<ReadonlyArray<DeletionFence>> {
    const directory = join(this.root, "deletion-fences");
    try {
      await access(directory, constants.R_OK);
    } catch {
      return [];
    }
    const entries = await readdir(directory);
    const fences = await Promise.all(
      entries.filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => this.readFence(join(directory, entry))),
    );
    return fences.filter((fence) => fence.status === "completed");
  }

  async blockSends(restoreRunId: string): Promise<void> {
    await this.appendGate({
      restore_run_id: restoreRunId,
      status: "blocked",
      recorded_at: new Date().toISOString(),
    });
  }

  async allowSends(restoreRunId: string): Promise<void> {
    const current = await this.readGate();
    if (!current || current.status !== "blocked" || current.restore_run_id !== restoreRunId) {
      throw new Error("Send gate is not blocked for this restore run");
    }
    await this.appendGate({
      restore_run_id: restoreRunId,
      status: "allowed",
      recorded_at: new Date().toISOString(),
    });
  }

  async isSendAllowed(): Promise<boolean> {
    return (await this.readGate())?.status === "allowed";
  }

  private fencePath(hash: string): string {
    return join(this.root, "deletion-fences", `${hash}.jsonl`);
  }

  private assertHash(hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid deletion lookup hash");
  }

  private async readFence(path: string): Promise<DeletionFence> {
    const entries = (await readFile(path, "utf8")).trim().split("\n");
    const latest = entries.at(-1);
    if (!latest) throw new Error("Deletion fence is empty");
    return JSON.parse(latest) as DeletionFence;
  }

  private async appendGate(entry: SendGateEntry): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.appendDurably(
      join(this.root, "send-gate.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
  }

  private async readGate(): Promise<SendGateEntry | null> {
    try {
      const entries = (await readFile(join(this.root, "send-gate.jsonl"), "utf8"))
        .trim()
        .split("\n");
      const latest = entries.at(-1);
      return latest ? JSON.parse(latest) as SendGateEntry : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async appendDurably(path: string, value: string): Promise<void> {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
