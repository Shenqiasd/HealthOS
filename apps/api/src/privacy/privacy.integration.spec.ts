import { randomUUID } from "node:crypto";

import { DatabaseService } from "../database/prisma.service";
import { PrivacyService } from "./privacy.service";

describe("privacy request integration", () => {
  const database = new DatabaseService();
  const fences = new Map<string, string>();
  const privacy = new PrivacyService(database, {
    tombstoneHashKey: "synthetic-tombstone-hash-key-at-least-32-bytes",
    tombstoneHashKeyVersion: "synthetic-v1",
    deletionStatusTokenKey: "synthetic-status-token-key-at-least-32-bytes",
  }, {
    beginDeletionFence: async (fence) => {
      const existingJobId = fences.get(fence.user_lookup_hash);
      const deletionJobId = existingJobId ?? fence.deletion_job_id;
      fences.set(fence.user_lookup_hash, deletionJobId);
      return {
        ...fence,
        deletion_job_id: deletionJobId,
        status: "pending" as const,
        created_at: new Date().toISOString(),
      };
    },
  });

  beforeAll(async () => {
    await database.$connect();
  });

  afterEach(async () => {
    fences.clear();
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        deletion_jobs,
        export_jobs,
        security_events,
        refresh_sessions,
        channel_outbox,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  test("deduplicates export requests by authenticated user and idempotency key", async () => {
    const user = await database.user.create({ data: {} });
    const idempotencyKey = randomUUID();

    const first = await privacy.requestExport(user.id, idempotencyKey);
    const second = await privacy.requestExport(user.id, idempotencyKey);

    expect(second.id).toBe(first.id);
    expect(first.status).toBe("requested");
    await expect(database.exportJob.count()).resolves.toBe(1);
    const otherUser = await database.user.create({ data: {} });
    await expect(privacy.getExport(otherUser.id, first.id)).rejects.toThrow(/not found/i);
  });

  test("delete request atomically freezes processing, revokes sessions, and suppresses sends", async () => {
    const user = await database.user.create({ data: {} });
    await database.refreshSession.create({
      data: {
        expiresAt: new Date(Date.now() + 60_000),
        familyId: randomUUID(),
        tokenHash: "synthetic-refresh-hash",
        userId: user.id,
      },
    });
    await database.channelOutbox.create({
      data: {
        channel: "apns",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "daily_ready",
        userId: user.id,
        consentRequirements: {
          create: { purpose: "notifications", grantEpoch: 1 },
        },
      },
    });
    await database.domainOutbox.create({
      data: {
        aggregateId: randomUUID(),
        eventType: "synthetic.health.recompute",
        idempotencyKey: randomUUID(),
        payload: { synthetic: true },
        userId: user.id,
        consentRequirements: {
          create: { purpose: "health_processing", grantEpoch: 1 },
        },
      },
    });

    const deletion = await privacy.requestDeletion(
      user.id,
      randomUUID(),
      randomUUID(),
    );

    expect(deletion.job.status).toBe("frozen");
    await expect(
      privacy.getDeletionByStatusToken(deletion.job.id, deletion.statusToken),
    ).resolves.toMatchObject({ status: "frozen" });
    await expect(
      privacy.getDeletionByStatusToken(deletion.job.id, "wrong-status-token"),
    ).rejects.toThrow(/not found/i);
    await expect(database.user.findUniqueOrThrow({ where: { id: user.id } })).resolves
      .toMatchObject({ status: "deleting" });
    expect(
      await database.refreshSession.count({
        where: { userId: user.id, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await database.channelOutbox.count({
        where: { userId: user.id, status: { in: ["pending", "leased"] } },
      }),
    ).toBe(0);
    expect(
      await database.domainOutbox.count({
        where: { userId: user.id, status: { in: ["pending", "leased"] } },
      }),
    ).toBe(0);
  });

  test("deduplicates repeated delete requests without unfreezing the user", async () => {
    const user = await database.user.create({ data: {} });
    const idempotencyKey = randomUUID();

    const first = await privacy.requestDeletion(
      user.id,
      idempotencyKey,
      randomUUID(),
    );
    const second = await privacy.requestDeletion(
      user.id,
      idempotencyKey,
      randomUUID(),
    );

    expect(second.job.id).toBe(first.job.id);
    expect(second.statusToken).toBe(first.statusToken);
    expect(second.job.status).toBe("frozen");
    await expect(database.deletionJob.count()).resolves.toBe(1);
  });
});
