import { randomUUID } from "node:crypto";

import { DatabaseService } from "../database/prisma.service";
import { FreshnessService } from "./freshness.service";
import { HealthIngestionService } from "./health-ingestion.service";
import type { HealthSyncBatchInput } from "./health-types";

describe("health ingestion integration", () => {
  const database = new DatabaseService();
  const ingestion = new HealthIngestionService(database);
  const freshness = new FreshnessService(database);

  beforeAll(async () => {
    await database.$connect();
  });

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        consumer_inbox,
        domain_outbox_consent_requirements,
        domain_outbox,
        daily_health_fact_revisions,
        health_sync_runs,
        consent_records,
        devices,
        profile_events,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function authorizedUser() {
    const user = await database.user.create({ data: { consentEpoch: 1 } });
    await database.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "health-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: "synthetic-health-consent",
        source: "synthetic",
      },
    });
    const device = await database.device.create({
      data: {
        userId: user.id,
        deviceId: "synthetic-primary-device",
        isPrimaryHealthDevice: true,
      },
    });
    return { user, device };
  }

  function batch(
    overrides: Partial<HealthSyncBatchInput> & Record<string, unknown> = {},
  ): HealthSyncBatchInput & Record<string, unknown> {
    const base: HealthSyncBatchInput = {
      idempotencyKey: randomUUID(),
      deviceId: "synthetic-primary-device",
      anchorEpoch: 4,
      timezone: "Asia/Shanghai",
      facts: [
        {
          localDate: "2026-07-10",
          metric: "steps",
          value: 8123,
          coverage: 1,
          sourceVector: [
            { sourceId: "synthetic-watch", kind: "watch", contribution: 1 },
          ],
        },
      ],
    };
    return { ...base, ...overrides };
  }

  test("accepts day facts with one server sequence and atomic projection outbox", async () => {
    const { user } = await authorizedUser();
    const result = await ingestion.ingest(user.id, randomUUID(), batch());

    expect(result.serverSequence).toBeGreaterThan(0n);
    expect(result.createdRevisionIds).toHaveLength(1);
    const revision = await database.dailyHealthFactRevision.findFirstOrThrow();
    expect(revision.serverSequence).toBe(result.serverSequence);
    expect(revision.canonicalValueJson).toEqual({ value: 8123 });
    const outbox = await database.domainOutbox.findFirstOrThrow({
      include: { consentRequirements: true },
    });
    expect(outbox.userId).toBe(user.id);
    expect(outbox.consentRequirements).toEqual([
      expect.objectContaining({ purpose: "health_processing", grantEpoch: 1 }),
    ]);
  });

  test("returns the original result for exact replay and conflicts on changed reuse", async () => {
    const { user } = await authorizedUser();
    const input = batch();
    const first = await ingestion.ingest(user.id, randomUUID(), input);
    const replay = await ingestion.ingest(user.id, randomUUID(), input);

    expect(replay).toEqual(first);
    await expect(
      ingestion.ingest(user.id, randomUUID(), {
        ...input,
        facts: [{ ...input.facts[0]!, value: 9000 }],
      }),
    ).rejects.toThrow(/idempotency|reused/i);
    await expect(database.healthSyncRun.count()).resolves.toBe(1);
    await expect(database.dailyHealthFactRevision.count()).resolves.toBe(1);
  });

  test("rejects missing consent, deleting users, and non-primary devices", async () => {
    const user = await database.user.create({ data: {} });
    await database.device.create({
      data: { userId: user.id, deviceId: "synthetic-primary-device" },
    });
    await expect(
      ingestion.ingest(user.id, randomUUID(), batch()),
    ).rejects.toThrow(/consent|primary/i);

    const authorized = await authorizedUser();
    await database.device.update({
      where: { id: authorized.device.id },
      data: { isPrimaryHealthDevice: false },
    });
    await expect(
      ingestion.ingest(authorized.user.id, randomUUID(), batch()),
    ).rejects.toThrow(/primary/i);
  });

  test("appends a superseding revision for changed source-vector input", async () => {
    const { user } = await authorizedUser();
    const first = await ingestion.ingest(user.id, randomUUID(), batch());
    const second = await ingestion.ingest(user.id, randomUUID(), batch({
      facts: [
        {
          localDate: "2026-07-10",
          metric: "steps",
          value: 8300,
          coverage: 0.9,
          sourceVector: [
            { sourceId: "synthetic-phone", kind: "phone", contribution: 0.2 },
            { sourceId: "synthetic-watch", kind: "watch", contribution: 0.8 },
          ],
        },
      ],
    }));

    expect(second.serverSequence).toBe(first.serverSequence + 1n);
    const revisions = await database.dailyHealthFactRevision.findMany({
      orderBy: { serverSequence: "asc" },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.supersedesId).toBe(revisions[0]?.id);
    const current = await database.$queryRaw<Array<{ canonical_value_json: { value: number } }>>`
      SELECT "canonical_value_json"
      FROM "current_daily_health_facts"
      WHERE "user_id" = ${user.id}::uuid
        AND "local_date" = DATE '2026-07-10'
        AND "metric" = 'steps'
    `;
    expect(current[0]?.canonical_value_json).toEqual({ value: 8300 });
  });

  test("enforces one primary health device per user at the database boundary", async () => {
    const { user } = await authorizedUser();
    await expect(
      database.device.create({
        data: {
          userId: user.id,
          deviceId: "synthetic-second-primary",
          isPrimaryHealthDevice: true,
        },
      }),
    ).rejects.toThrow();
  });

  test("schedules bounded reconciliation on anchor epoch advance and rejects rollback", async () => {
    const { user } = await authorizedUser();
    await ingestion.ingest(user.id, randomUUID(), batch({ anchorEpoch: 4 }));
    await ingestion.ingest(user.id, randomUUID(), batch({
      anchorEpoch: 5,
      facts: [{
        localDate: "2026-07-11",
        metric: "steps",
        value: 7000,
        coverage: 1,
        sourceVector: [
          { sourceId: "synthetic-watch", kind: "watch", contribution: 1 },
        ],
      }],
    }));

    await expect(
      database.domainOutbox.findFirstOrThrow({
        where: { eventType: "health.reconciliation.requested" },
      }),
    ).resolves.toMatchObject({
      payload: expect.objectContaining({ window_days: 90 }),
    });
    await expect(
      ingestion.ingest(user.id, randomUUID(), batch({ anchorEpoch: 3 })),
    ).rejects.toThrow(/anchor|backwards/i);
  });

  test("rejects impossible values, malformed timezones, and raw sample fields", async () => {
    const { user } = await authorizedUser();
    await expect(
      ingestion.ingest(user.id, randomUUID(), batch({
        facts: [{
          localDate: "2026-07-10",
          metric: "resting_heart_rate_bpm",
          value: 500,
          coverage: 1,
          sourceVector: [],
        }],
      })),
    ).rejects.toThrow(/value|range|source/i);
    await expect(
      ingestion.ingest(user.id, randomUUID(), batch({ timezone: "Mars/Olympus" })),
    ).rejects.toThrow(/timezone/i);
    const rawBatch = batch();
    rawBatch.rawSamples = [{ heartRate: 80 }];
    await expect(
      ingestion.ingest(user.id, randomUUID(), rawBatch),
    ).rejects.toThrow(/raw|schema|field/i);
  });

  test("reports absent, partial, current, and stale freshness without interpretation", async () => {
    const { user } = await authorizedUser();
    await expect(
      freshness.forUser(user.id, new Date("2026-07-10T12:00:00.000Z")),
    ).resolves.toMatchObject({ status: "absent" });

    await ingestion.ingest(user.id, randomUUID(), batch({
      facts: [
        {
          localDate: "2026-07-10",
          metric: "sleep_minutes",
          value: 420,
          coverage: 0.5,
          sourceVector: [
            { sourceId: "synthetic-watch", kind: "watch", contribution: 1 },
          ],
        },
      ],
    }));
    await expect(
      freshness.forUser(user.id, new Date("2026-07-10T12:00:00.000Z")),
    ).resolves.toMatchObject({ status: "partial", latestLocalDate: "2026-07-10" });
    await expect(
      freshness.forUser(user.id, new Date("2026-07-14T12:00:00.000Z")),
    ).resolves.toMatchObject({ status: "stale" });
  });

  test("calculates freshness against the latest batch timezone at a UTC date boundary", async () => {
    const { user } = await authorizedUser();
    await ingestion.ingest(user.id, randomUUID(), batch({
      timezone: "America/Los_Angeles",
      facts: [{
        localDate: "2026-07-09",
        metric: "steps",
        value: 5000,
        coverage: 1,
        sourceVector: [
          { sourceId: "synthetic-phone", kind: "phone", contribution: 1 },
        ],
      }],
    }));

    await expect(
      freshness.forUser(user.id, new Date("2026-07-10T06:30:00.000Z")),
    ).resolves.toMatchObject({ status: "current", latestLocalDate: "2026-07-09" });
  });
});
