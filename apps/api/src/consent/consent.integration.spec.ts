import { randomUUID } from "node:crypto";

import { DatabaseService } from "../database/prisma.service";
import { ConsentService } from "./consent.service";

describe("consent lifecycle integration", () => {
  const database = new DatabaseService();
  let externalSendAllowed = true;
  const consent = new ConsentService(database, {
    isSendAllowed: async () => externalSendAllowed,
  });

  beforeAll(async () => {
    await database.$connect();
  });

  afterEach(async () => {
    externalSendAllowed = true;
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        consent_records,
        channel_outbox,
        users
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.upsert({
      where: { id: "global" },
      create: { id: "global", status: "ready" },
      update: { status: "ready", completedAt: new Date() },
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  test("advances one global epoch while keeping purposes independent", async () => {
    const user = await database.user.create({ data: {} });

    const health = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "health-v1",
      granted: true,
      purpose: "health_processing",
      source: "ios",
    });
    const notifications = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: false,
      purpose: "notifications",
      source: "ios",
    });

    expect(health.epoch).toBe(1);
    expect(notifications.epoch).toBe(2);
    await expect(consent.current(user.id)).resolves.toMatchObject({
      consentEpoch: 2,
      purposes: {
        health_processing: { granted: true, documentVersion: "health-v1" },
        notifications: { granted: false, documentVersion: "notifications-v1" },
      },
    });
  });

  test("keeps consent records append-only", async () => {
    const user = await database.user.create({ data: {} });
    const record = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "health-v1",
      granted: true,
      purpose: "health_processing",
      source: "ios",
    });

    await expect(
      database.consentRecord.update({
        where: { id: record.id },
        data: { granted: false },
      }),
    ).rejects.toThrow();
    await expect(
      database.consentRecord.delete({ where: { id: record.id } }),
    ).rejects.toThrow();
  });

  test("deduplicates concurrent consent writes and rejects changed payload reuse", async () => {
    const user = await database.user.create({ data: {} });
    const correlationId = randomUUID();
    const input = {
      correlationId,
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications" as const,
      source: "ios",
    };

    const [first, second] = await Promise.all([
      consent.record(user.id, input),
      consent.record(user.id, input),
    ]);

    expect(second.id).toBe(first.id);
    expect(first.epoch).toBe(1);
    await expect(database.consentRecord.count()).resolves.toBe(1);
    await expect(
      database.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).resolves.toMatchObject({ consentEpoch: 1 });
    await expect(
      consent.record(user.id, { ...input, granted: false }),
    ).rejects.toThrow(/idempotency|reused/i);
  });

  test("withdrawal suppresses queued sends for that purpose only", async () => {
    const user = await database.user.create({ data: {} });
    const notificationGrant = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications",
      source: "ios",
    });
    const healthGrant = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "health-v1",
      granted: true,
      purpose: "health_processing",
      source: "ios",
    });
    const notificationOutbox = await database.channelOutbox.create({
      data: {
        channel: "apns",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "daily_ready",
        userId: user.id,
        consentRequirements: {
          create: { purpose: "notifications", grantEpoch: notificationGrant.epoch },
        },
      },
    });
    const healthOutbox = await database.channelOutbox.create({
      data: {
        channel: "internal",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "projection_ready",
        userId: user.id,
        consentRequirements: {
          create: { purpose: "health_processing", grantEpoch: healthGrant.epoch },
        },
      },
    });

    await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: false,
      purpose: "notifications",
      source: "ios",
    });

    await expect(
      database.channelOutbox.findUniqueOrThrow({
        where: { id: notificationOutbox.id },
      }),
    ).resolves.toMatchObject({ status: "suppressed" });
    await expect(
      database.channelOutbox.findUniqueOrThrow({ where: { id: healthOutbox.id } }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  test("provider eligibility rechecks current consent and reconciliation state", async () => {
    const user = await database.user.create({ data: {} });
    const grant = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications",
      source: "ios",
    });
    const outbox = await database.channelOutbox.create({
      data: {
        channel: "apns",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "daily_ready",
        userId: user.id,
        consentRequirements: {
          create: { purpose: "notifications", grantEpoch: grant.epoch },
        },
      },
    });

    await expect(
      consent.invokeAuthorizedProvider(outbox.id, async (authorization) => authorization),
    ).resolves.toMatchObject({ consentEpoch: 1, userId: user.id });
    await database.privacyReconciliation.update({
      where: { id: "global" },
      data: { status: "required", completedAt: null },
    });
    externalSendAllowed = false;
    await expect(
      consent.invokeAuthorizedProvider(outbox.id, async () => "not-called"),
    ).rejects.toThrow(
      /reconciliation|send/i,
    );
    await expect(
      database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({ status: "suppressed" });
  });

  test("requires every queued purpose and never revives an old message after re-grant", async () => {
    const user = await database.user.create({ data: {} });
    const health = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "health-v1",
      granted: true,
      purpose: "health_processing",
      source: "ios",
    });
    const notifications = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications",
      source: "ios",
    });
    const outbox = await database.channelOutbox.create({
      data: {
        channel: "apns",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "daily_ready",
        userId: user.id,
        consentRequirements: {
          create: [
            { purpose: "health_processing", grantEpoch: health.epoch },
            { purpose: "notifications", grantEpoch: notifications.epoch },
          ],
        },
      },
    });

    await expect(
      consent.invokeAuthorizedProvider(outbox.id, async () => "sent"),
    ).resolves.toBe("sent");
    await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: false,
      purpose: "notifications",
      source: "ios",
    });
    await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications",
      source: "ios",
    });
    await expect(
      consent.invokeAuthorizedProvider(outbox.id, async () => "must-not-send"),
    ).rejects.toThrow(/not sendable|consent/i);
  });

  test("serializes provider invocation before a concurrent withdrawal commits", async () => {
    const user = await database.user.create({ data: {} });
    const grant = await consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: true,
      purpose: "notifications",
      source: "ios",
    });
    const outbox = await database.channelOutbox.create({
      data: {
        channel: "apns",
        idempotencyKey: randomUUID(),
        payload: { template_data: "synthetic" },
        template: "daily_ready",
        userId: user.id,
        consentRequirements: {
          create: { purpose: "notifications", grantEpoch: grant.epoch },
        },
      },
    });
    let enterProvider!: () => void;
    let releaseProvider!: () => void;
    const providerEntered = new Promise<void>((resolve) => { enterProvider = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let withdrawalCommitted = false;

    const sending = consent.invokeAuthorizedProvider(outbox.id, async () => {
      enterProvider();
      await providerRelease;
      return "sent";
    });
    await providerEntered;
    const withdrawing = consent.record(user.id, {
      correlationId: randomUUID(),
      documentVersion: "notifications-v1",
      granted: false,
      purpose: "notifications",
      source: "ios",
    }).then(() => { withdrawalCommitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(withdrawalCommitted).toBe(false);
    releaseProvider();
    await expect(sending).resolves.toBe("sent");
    await withdrawing;
    expect(withdrawalCommitted).toBe(true);
  });
});
