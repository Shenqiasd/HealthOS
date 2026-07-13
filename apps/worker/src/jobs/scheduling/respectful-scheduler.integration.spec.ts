import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { PrismaClient } from "@prisma/client";

import { RespectfulScheduler } from "./respectful-scheduler";

const database = new PrismaClient();
const scheduler = new RespectfulScheduler(database);

before(async () => { await database.$connect(); });
after(async () => { await database.$disconnect(); });
beforeEach(async () => {
  await database.$executeRawUnsafe("TRUNCATE TABLE users, audit_logs, privacy_reconciliation RESTART IDENTITY CASCADE");
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
});

async function configuredUser(input: {
  timezone?: string;
  enabled?: boolean;
  intensity?: "gentle" | "standard";
  notifications?: boolean;
  weeklyDay?: number;
  advisorMinute?: number;
  behaviorMinute?: number;
  weeklyMinute?: number;
  quietStartMinute?: number;
  quietEndMinute?: number;
  preferenceCreatedAt?: Date;
}) {
  const preferenceCreatedAt = input.preferenceCreatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const user = await database.user.create({ data: { timezone: input.timezone ?? "Asia/Shanghai", consentEpoch: 1 } });
  const preference = await database.reminderPreference.create({ data: {
    userId: user.id, version: 1, enabled: input.enabled ?? true, intensity: input.intensity ?? "standard",
    quietStartMinute: input.quietStartMinute ?? 22 * 60,
    quietEndMinute: input.quietEndMinute ?? 7 * 60,
    advisorMinute: input.advisorMinute ?? 8 * 60 + 30,
    behaviorMinute: input.behaviorMinute ?? 18 * 60 + 30,
    weeklyDay: input.weeklyDay ?? 1,
    weeklyMinute: input.weeklyMinute ?? 9 * 60,
    createdAt: preferenceCreatedAt,
    updatedAt: preferenceCreatedAt,
  } });
  await database.reminderPreferenceRevision.create({ data: {
    userId: user.id,
    version: preference.version,
    enabled: preference.enabled,
    intensity: preference.intensity,
    timezone: user.timezone,
    quietStartMinute: preference.quietStartMinute,
    quietEndMinute: preference.quietEndMinute,
    advisorMinute: preference.advisorMinute,
    behaviorMinute: preference.behaviorMinute,
    weeklyDay: preference.weeklyDay,
    weeklyMinute: preference.weeklyMinute,
    effectiveAt: preference.updatedAt,
  } });
  await database.consentRecord.create({ data: {
    userId: user.id, consentType: "notifications", documentVersion: "synthetic-notifications-v1",
    granted: input.notifications ?? true, epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  return user;
}

function liveUtcConfiguration(now: Date) {
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const preferenceCreatedAt = new Date(
    now.getTime() - now.getUTCSeconds() * 1_000 - now.getUTCMilliseconds() - 1,
  );
  return {
    timezone: "UTC",
    advisorMinute: minute,
    behaviorMinute: minute,
    weeklyMinute: minute,
    weeklyDay: (((now.getUTCDay() + 6) % 7) + 1) % 7 + 1,
    quietStartMinute: (minute + 60) % 1440,
    quietEndMinute: (minute + 120) % 1440,
    preferenceCreatedAt,
  };
}

async function revisePreference(
  userId: string,
  input: { timezone: string; weeklyDay?: number; effectiveAt: Date },
) {
  const current = await database.reminderPreference.findUniqueOrThrow({ where: { userId } });
  const preference = await database.reminderPreference.update({ where: { userId }, data: {
    version: current.version + 1,
    weeklyDay: input.weeklyDay ?? current.weeklyDay,
    updatedAt: input.effectiveAt,
  } });
  await database.user.update({ where: { id: userId }, data: { timezone: input.timezone } });
  await database.reminderPreferenceRevision.create({ data: {
    userId,
    version: preference.version,
    enabled: preference.enabled,
    intensity: preference.intensity,
    timezone: input.timezone,
    quietStartMinute: preference.quietStartMinute,
    quietEndMinute: preference.quietEndMinute,
    advisorMinute: preference.advisorMinute,
    behaviorMinute: preference.behaviorMinute,
    weeklyDay: preference.weeklyDay,
    weeklyMinute: preference.weeklyMinute,
    effectiveAt: preference.updatedAt,
  } });
}

test("plans one advisor and one behavior reminder exactly once without external delivery", async () => {
  const now = new Date();
  const user = await configuredUser(liveUtcConfiguration(now));
  const concurrent = await Promise.all(Array.from({ length: 50 }, () =>
    scheduler.runDue(now)));
  assert.equal(concurrent.reduce((sum, value) => sum + value, 0), 2);
  assert.equal(await scheduler.runDue(now), 0);
  assert.equal(await database.schedulePlan.count({ where: { userId: user.id, status: "planned" } }), 2);
  assert.equal(await database.channelOutbox.count(), 0);
  assert.equal(await database.deliveryAttempt.count(), 0);
});

test("suppresses disabled, gentle behavior, missing-consent, and missed-cutoff decisions", async () => {
  await configuredUser({ enabled: false });
  await configuredUser({ intensity: "gentle" });
  await configuredUser({ notifications: false });
  await scheduler.runDue(new Date("2026-07-01T12:00:00.000Z"));
  const reasons = (await database.schedulePlan.findMany({ select: { suppressionReason: true } }))
    .map(({ suppressionReason }) => suppressionReason);
  assert.ok(reasons.includes("disabled"));
  assert.ok(reasons.includes("intensity_disabled"));
  assert.ok(reasons.includes("notification_consent_missing"));
  assert.ok(reasons.includes("missed_cutoff"));
  assert.equal(await database.schedulePlan.count({ where: { status: "planned" } }), 0);
});

test("travel and late facts never duplicate a local-day decision", async () => {
  const now = new Date();
  const user = await configuredUser(liveUtcConfiguration(now));
  await scheduler.runDue(now);
  await revisePreference(user.id, {
    timezone: "America/Los_Angeles",
    effectiveAt: new Date(now.getTime() + 1),
  });
  await database.dailyHealthFactRevision.create({ data: {
    userId: user.id, localDate: new Date("2026-07-01T00:00:00.000Z"), metric: "steps",
    canonicalValueJson: { steps: 8000 }, sourceVectorJson: { synthetic: true }, inputHash: randomUUID(),
  } });
  await scheduler.runDue(new Date(now.getTime() + 2));
  assert.equal(await database.schedulePlan.count({ where: { userId: user.id, kind: "daily_advisor" } }), 1);
});

test("suppresses a DST-gap target when the resolved wall time enters quiet hours", async () => {
  const user = await configuredUser({
    timezone: "America/New_York",
    advisorMinute: 2 * 60 + 30,
    quietStartMinute: 3 * 60,
    quietEndMinute: 4 * 60,
  });
  await scheduler.runDue(new Date("2026-03-08T07:35:00.000Z"));
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id,
    kind: "daily_advisor",
    suppressionReason: "quiet_window_exhausted",
  } }), 1);
});

test("backfill preserves the effective weekly occurrence and uses the new timezone afterward", async () => {
  const user = await configuredUser({
    timezone: "Asia/Shanghai",
    weeklyDay: 3,
    preferenceCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  await revisePreference(user.id, {
    timezone: "America/New_York",
    weeklyDay: 7,
    effectiveAt: new Date("2026-07-05T00:00:00.000Z"),
  });
  await scheduler.runDue(new Date("2026-07-06T18:05:00.000Z"));
  const weekly = await database.schedulePlan.findMany({
    where: { userId: user.id, kind: "weekly_review" },
    orderBy: { localDate: "asc" },
  });
  assert.deepEqual(weekly.map((plan) => [
    plan.localDate.toISOString().slice(0, 10), plan.preferenceVersion, plan.timezone,
  ]), [["2026-07-01", 1, "Asia/Shanghai"]]);
  const afterTravel = await database.schedulePlan.findFirstOrThrow({ where: {
    userId: user.id,
    kind: "daily_advisor",
    localDate: new Date("2026-07-05T00:00:00.000Z"),
  } });
  assert.equal(afterTravel.preferenceVersion, 2);
  assert.equal(afterTravel.timezone, "America/New_York");
});

test("database rejects forged authorization, offset, version jumps, and plan mutation", async () => {
  const user = await configuredUser({});
  const base = {
    userId: user.id,
    kind: "daily_advisor",
    localDate: new Date("2026-07-01T00:00:00.000Z"),
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    timezone: "Asia/Shanghai",
    scheduledAt: new Date("2026-07-01T00:30:00.000Z"),
    cutoffAt: new Date("2026-07-01T02:30:00.000Z"),
    evaluatedAt: new Date("2026-07-01T00:35:00.000Z"),
    requestedMinute: 8 * 60 + 30,
    resolvedLocalMinute: 8 * 60 + 30,
    preferenceVersion: 1,
    notificationConsentEpoch: null,
    status: "suppressed",
    suppressionReason: "missed_cutoff",
  } as const;
  await assert.rejects(database.schedulePlan.create({ data: { ...base, utcOffsetMinutes: 0 } }), /offset/i);
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    timezone: "UTC",
    scheduledAt: new Date("2026-07-01T08:30:00.000Z"),
    cutoffAt: new Date("2026-07-01T10:30:00.000Z"),
    evaluatedAt: new Date("2026-07-01T08:35:00.000Z"),
    utcOffsetMinutes: 0,
  } }), /preference revision timezone/i);
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    cutoffAt: new Date("2026-07-01T03:30:00.000Z"),
    utcOffsetMinutes: 8 * 60,
  } }), /cutoff/i);
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    periodStart: new Date("2026-06-30T00:00:00.000Z"),
    utcOffsetMinutes: 8 * 60,
  } }), /period/i);
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    resolvedLocalMinute: 9 * 60 + 30,
    utcOffsetMinutes: 8 * 60,
  } }), /resolved local minute|transition/i);
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    notificationConsentEpoch: 1,
    status: "planned",
    suppressionReason: null,
    evaluatedAt: new Date("2026-07-01T00:35:00.000Z"),
    utcOffsetMinutes: 8 * 60,
  } }), /suppression reason|authorized/i);
  const preference = await database.reminderPreference.findUniqueOrThrow({ where: { userId: user.id } });
  await assert.rejects(database.reminderPreference.update({ where: { userId: user.id }, data: {
    version: 3,
    updatedAt: new Date(preference.updatedAt.getTime() + 1),
  } }), /version/i);
  await database.schedulePlan.create({ data: { ...base, utcOffsetMinutes: 8 * 60 } });
  const plan = await database.schedulePlan.findFirstOrThrow({ where: { userId: user.id } });
  await assert.rejects(database.schedulePlan.update({ where: { id: plan.id }, data: { status: "suppressed" } }), /append-only/i);

  const noConsent = await configuredUser({ notifications: false });
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    userId: noConsent.id,
    notificationConsentEpoch: 1,
    utcOffsetMinutes: 8 * 60,
  } }), /suppression reason|authorized/i);

  const disabled = await configuredUser({ enabled: false });
  await assert.rejects(database.schedulePlan.create({ data: {
    ...base,
    userId: disabled.id,
    notificationConsentEpoch: null,
    status: "suppressed",
    suppressionReason: "missed_cutoff",
    utcOffsetMinutes: 8 * 60,
  } }), /suppression reason/i);
});

test("database enforces Temporal-compatible overlap and non-hour gap instants", async () => {
  const overlap = await configuredUser({
    timezone: "America/New_York", advisorMinute: 90, quietStartMinute: 3 * 60, quietEndMinute: 4 * 60,
  });
  const common = {
    kind: "daily_advisor",
    localDate: new Date("2026-11-01T00:00:00.000Z"),
    periodStart: new Date("2026-11-01T00:00:00.000Z"),
    timezone: "America/New_York",
    cutoffAt: new Date("2026-11-01T08:30:00.000Z"),
    evaluatedAt: new Date("2026-11-01T06:35:00.000Z"),
    requestedMinute: 90,
    resolvedLocalMinute: 90,
    preferenceVersion: 1,
    notificationConsentEpoch: null,
    status: "suppressed",
    suppressionReason: "missed_cutoff",
  } as const;
  await assert.rejects(database.schedulePlan.create({ data: {
    ...common,
    userId: overlap.id,
    scheduledAt: new Date("2026-11-01T06:30:00.000Z"),
    utcOffsetMinutes: -5 * 60,
  } }), /canonical IANA instant/i);

  const lordHowe = await configuredUser({
    timezone: "Australia/Lord_Howe", advisorMinute: 2 * 60 + 15,
    quietStartMinute: 3 * 60, quietEndMinute: 4 * 60,
  });
  await assert.doesNotReject(database.schedulePlan.create({ data: {
    ...common,
    userId: lordHowe.id,
    localDate: new Date("2025-10-05T00:00:00.000Z"),
    periodStart: new Date("2025-10-05T00:00:00.000Z"),
    timezone: "Australia/Lord_Howe",
    scheduledAt: new Date("2025-10-04T15:45:00.000Z"),
    cutoffAt: new Date("2025-10-04T17:45:00.000Z"),
    evaluatedAt: new Date("2025-10-04T15:50:00.000Z"),
    requestedMinute: 2 * 60 + 15,
    resolvedLocalMinute: 2 * 60 + 45,
    utcOffsetMinutes: 11 * 60,
  } }));
});

test("notification withdrawal and regrant never revive an existing occurrence", async () => {
  const now = new Date();
  const user = await configuredUser(liveUtcConfiguration(now));
  await scheduler.runDue(now);
  await database.consentRecord.create({ data: {
    userId: user.id, consentType: "notifications", documentVersion: "synthetic-notifications-v2",
    granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  await database.consentRecord.create({ data: {
    userId: user.id, consentType: "notifications", documentVersion: "synthetic-notifications-v3",
    granted: true, epoch: 3, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  await scheduler.runDue(new Date(now.getTime() + 1));
  const plans = await database.schedulePlan.findMany({ where: { userId: user.id, kind: "daily_advisor" } });
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.notificationConsentEpoch, 1);
});

test("durably backfills missed daily and weekly occurrences after downtime", async () => {
  const user = await configuredUser({ weeklyDay: 7 });
  await scheduler.runDue(new Date("2026-06-30T00:00:00.000Z"));
  await scheduler.runDue(new Date("2026-07-06T04:00:00.000Z"));
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id,
    kind: "daily_advisor",
    localDate: new Date("2026-07-01T00:00:00.000Z"),
    suppressionReason: "missed_cutoff",
  } }), 1);
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id,
    kind: "weekly_review",
    localDate: new Date("2026-07-05T00:00:00.000Z"),
    suppressionReason: "missed_cutoff",
  } }), 1);
});

test("cold start backfills from preference creation without a seeded watermark", async () => {
  const user = await configuredUser({
    weeklyDay: 7,
    preferenceCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  await scheduler.runDue(new Date("2026-07-06T04:00:00.000Z"));
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id,
    kind: "daily_advisor",
    localDate: { gte: new Date("2026-07-01T00:00:00.000Z"), lte: new Date("2026-07-05T00:00:00.000Z") },
    suppressionReason: "missed_cutoff",
  } }), 5);
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id,
    kind: "weekly_review",
    localDate: new Date("2026-07-05T00:00:00.000Z"),
    suppressionReason: "missed_cutoff",
  } }), 1);
});

test("runs the real scheduler for fourteen exact days across three IANA zones", async () => {
  const users = await Promise.all([
    "Asia/Shanghai",
    "America/New_York",
    "Europe/London",
  ].map((timezone) => configuredUser({
    timezone,
    advisorMinute: 0,
    behaviorMinute: 0,
    weeklyDay: 1,
    weeklyMinute: 0,
    quietStartMinute: 60,
    quietEndMinute: 120,
    preferenceCreatedAt: new Date("2026-05-01T00:00:00.000Z"),
  })));
  await database.schedulerWatermark.createMany({ data: users.map((user) => ({
    userId: user.id,
    lastEvaluatedAt: new Date("2026-06-01T09:59:00.000Z"),
    lastLocalDate: new Date("2026-06-01T00:00:00.000Z"),
    timezone: user.timezone,
  })) });

  let inserted = 0;
  for (let day = 1; day <= 14; day += 1) {
    const now = new Date(`2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`);
    inserted += await scheduler.runDue(now);
    assert.equal(await scheduler.runDue(now), 0);
  }

  assert.equal(inserted, 90);
  for (const user of users) {
    assert.equal(await database.schedulePlan.count({ where: { userId: user.id, kind: "daily_advisor" } }), 14);
    assert.equal(await database.schedulePlan.count({ where: { userId: user.id, kind: "behavior_reminder" } }), 14);
    assert.equal(await database.schedulePlan.count({ where: { userId: user.id, kind: "weekly_review" } }), 2);
  }
  assert.equal(await database.schedulePlan.count({ where: { suppressionReason: "missed_cutoff" } }), 90);
  assert.equal(await database.schedulePlan.count({ where: { suppressionReason: "quiet_window_exhausted" } }), 0);
  assert.equal(await database.channelOutbox.count(), 0);
  assert.equal(await database.deliveryAttempt.count(), 0);
});

test("privacy unavailable stays retryable and one malformed timezone cannot block another user", async () => {
  const now = new Date();
  const retryable = await configuredUser(liveUtcConfiguration(now));
  await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "running" } });
  await scheduler.runDue(now);
  assert.equal(await database.schedulePlan.count({ where: { userId: retryable.id } }), 0);
  await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
  const malformed = await configuredUser({ ...liveUtcConfiguration(now), timezone: "Mars/Olympus" });
  await scheduler.runDue(now);
  assert.equal(await database.schedulePlan.count({ where: {
    userId: retryable.id, kind: "daily_advisor", status: "planned",
  } }), 1);
  assert.equal(await database.schedulePlan.count({ where: { userId: malformed.id } }), 0);
});

test("isolated user failures are observable without blocking healthy users", async () => {
  const errors: string[] = [];
  const observableScheduler = new RespectfulScheduler(database, {
    error(message: string) { errors.push(message); },
  });
  const now = new Date();
  const healthy = await configuredUser(liveUtcConfiguration(now));
  await configuredUser({ ...liveUtcConfiguration(now), timezone: "Mars/Olympus" });
  await observableScheduler.runDue(now);
  assert.equal(await database.schedulePlan.count({ where: {
    userId: healthy.id, kind: "daily_advisor", status: "planned",
  } }), 1);
  assert.equal(errors.length, 2);
  assert.deepEqual(JSON.parse(errors[0]!), {
    event: "respectful_scheduler_user_failed",
    user_reference: errors[0]!.match(/"user_reference":"([a-f0-9]{12})"/)?.[1],
    error_category: "invalid_timezone",
  });
  assert.deepEqual(JSON.parse(errors[1]!), {
    event: "respectful_scheduler_pass_completed_with_failures",
    failed_users: 1,
  });
});

test("serializes a notification withdrawal before planning on the shared user lock", async () => {
  const now = new Date();
  const user = await configuredUser(liveUtcConfiguration(now));
  const other = new PrismaClient();
  await other.$connect();
  let markLocked!: () => void;
  let releaseWithdrawal!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseWithdrawal = resolve; });
  const withdrawal = other.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    await tx.consentRecord.create({ data: {
      userId: user.id, consentType: "notifications", documentVersion: "synthetic-notifications-v2",
      granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    markLocked();
    await release;
  });
  await locked;
  const planning = scheduler.runDue(now);
  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseWithdrawal();
  await withdrawal;
  await planning;
  await other.$disconnect();
  assert.equal(await database.schedulePlan.count({ where: { userId: user.id, status: "planned" } }), 0);
  assert.equal(await database.schedulePlan.count({ where: {
    userId: user.id, kind: "daily_advisor", suppressionReason: "notification_consent_missing",
  } }), 1);
});
