import { randomBytes, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";
import { createApp } from "../main";

describe("reminder preferences API", () => {
  const database = new DatabaseService();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.reminders.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-reminders-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-reminders-subject-hash-key";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await database.$connect();
    app = await createApp();
  });

  afterAll(async () => { await app.close(); await database.$disconnect(); });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, audit_logs, privacy_reconciliation RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  async function identity(timezone = "Asia/Shanghai") {
    const user = await database.user.create({ data: { timezone, consentEpoch: 1 } });
    const tokens = await app.get(SessionService).issue(user.id);
    return { user, headers: { authorization: `Bearer ${tokens.accessToken}` } };
  }

  const preference = {
    expected_version: 0,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    enabled: true,
    intensity: "standard",
    timezone: "Asia/Shanghai",
    quiet_hours: { start: "22:00", end: "07:00" },
    advisor_time: "08:30",
    behavior_time: "18:30",
    weekly_report: { day: "monday", time: "09:00" },
  };

  test("is authenticated, versioned, idempotent, and owner scoped", async () => {
    const first = await identity();
    const second = await identity("Europe/London");
    expect((await app.inject({ method: "GET", url: "/reminders/preferences" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/reminders/preferences", headers: first.headers })).json()).toMatchObject({
      version: 0, enabled: false, intensity: "gentle", timezone: "Asia/Shanghai",
    });
    const created = await app.inject({ method: "PUT", url: "/reminders/preferences", headers: first.headers, payload: preference });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ version: 1, enabled: true, intensity: "standard", timezone: "Asia/Shanghai" });
    const replay = await app.inject({ method: "PUT", url: "/reminders/preferences", headers: first.headers, payload: preference });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "running" } });
    expect((await app.inject({ method: "GET", url: "/reminders/preferences", headers: first.headers })).statusCode).toBe(503);
    expect((await app.inject({ method: "PUT", url: "/reminders/preferences", headers: first.headers, payload: preference })).statusCode).toBe(503);
    await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
    expect((await app.inject({
      method: "PUT", url: "/reminders/preferences", headers: first.headers,
      payload: { ...preference, enabled: false },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PUT", url: "/reminders/preferences", headers: first.headers,
      payload: { ...preference, idempotency_key: randomUUID() },
    })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/reminders/preferences", headers: second.headers })).json()).toMatchObject({
      version: 0, enabled: false, timezone: "Europe/London",
    });
    const traveled = await app.inject({
      method: "PUT", url: "/reminders/preferences", headers: first.headers,
      payload: { ...preference, expected_version: 1, idempotency_key: randomUUID(), timezone: "America/New_York" },
    });
    expect(traveled.statusCode).toBe(200);
    expect(traveled.json()).toMatchObject({ version: 2, timezone: "America/New_York" });
    expect(await database.user.findUniqueOrThrow({ where: { id: first.user.id } })).toMatchObject({ timezone: "America/New_York" });
    expect(await database.reminderPreference.count()).toBe(1);
  });

  test("rejects invalid timezone, quiet-hour targets, unknown fields, and unsafe intensity", async () => {
    const user = await identity();
    for (const payload of [
      { ...preference, timezone: "Mars/Olympus" },
      { ...preference, advisor_time: "23:00" },
      { ...preference, quiet_hours: { start: "07:00", end: "07:00" } },
      { ...preference, intensity: "aggressive" },
      { ...preference, channel: "wecom" },
    ]) {
      expect((await app.inject({ method: "PUT", url: "/reminders/preferences", headers: user.headers, payload })).statusCode).toBe(400);
    }
  });

  test("privacy deletion removes preferences, mutation receipts, and schedule decisions", async () => {
    const identity_ = await identity();
    const effectiveAt = new Date("2025-01-01T00:00:00.000Z");
    await database.reminderPreference.create({ data: {
      userId: identity_.user.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      quietStartMinute: 22 * 60,
      quietEndMinute: 7 * 60,
      advisorMinute: 8 * 60 + 30,
      behaviorMinute: 18 * 60 + 30,
      weeklyDay: 1,
      weeklyMinute: 9 * 60,
      createdAt: effectiveAt,
      updatedAt: effectiveAt,
    } });
    await database.reminderPreferenceRevision.create({ data: {
      userId: identity_.user.id,
      version: 1,
      enabled: true,
      intensity: "standard",
      timezone: "Asia/Shanghai",
      quietStartMinute: 22 * 60,
      quietEndMinute: 7 * 60,
      advisorMinute: 8 * 60 + 30,
      behaviorMinute: 18 * 60 + 30,
      weeklyDay: 1,
      weeklyMinute: 9 * 60,
      effectiveAt,
    } });
    await database.reminderPreferenceMutation.create({ data: {
      userId: identity_.user.id,
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
      resultJson: { synthetic: true },
    } });
    await database.schedulePlan.create({ data: {
      userId: identity_.user.id,
      kind: "daily_advisor",
      localDate: new Date("2026-07-11T00:00:00.000Z"),
      periodStart: new Date("2026-07-11T00:00:00.000Z"),
      timezone: "Asia/Shanghai",
      scheduledAt: new Date("2026-07-11T00:30:00.000Z"),
      cutoffAt: new Date("2026-07-11T02:30:00.000Z"),
      evaluatedAt: new Date("2026-07-11T00:35:00.000Z"),
      requestedMinute: 8 * 60 + 30,
      resolvedLocalMinute: 8 * 60 + 30,
      utcOffsetMinutes: 8 * 60,
      preferenceVersion: 1,
      notificationConsentEpoch: null,
      status: "suppressed",
      suppressionReason: "notification_consent_missing",
    } });
    await database.schedulerWatermark.create({ data: {
      userId: identity_.user.id,
      lastEvaluatedAt: new Date("2026-07-11T00:35:00.000Z"),
      lastLocalDate: new Date("2026-07-11T00:00:00.000Z"),
      timezone: "Asia/Shanghai",
    } });
    await database.user.update({ where: { id: identity_.user.id }, data: { status: "deleting", deletedAt: new Date() } });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${identity_.user.id}::uuid)`;
    expect(await database.reminderPreference.count()).toBe(0);
    expect(await database.reminderPreferenceMutation.count()).toBe(0);
    expect(await database.reminderPreferenceRevision.count()).toBe(0);
    expect(await database.schedulePlan.count()).toBe(0);
    expect(await database.schedulerWatermark.count()).toBe(0);
  });
});
