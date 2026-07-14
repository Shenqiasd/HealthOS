import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { PrismaClient, type Prisma } from "@prisma/client";

import {
  ChannelDeliveryWorker,
  PermanentDeliveryError,
  RetryableDeliveryError,
  UnknownAfterSendError,
  type ChannelProvider,
  type ProviderDelivery,
} from "./channel-delivery-worker";
import { renderChannelTemplate } from "./channel-template";

const database = new PrismaClient();

class SyntheticProvider implements ChannelProvider {
  calls: ProviderDelivery[] = [];
  mode: "sent" | "unknown" | "retryable" | "permanent" | "blocking" = "sent";
  entered: (() => void) | null = null;
  release: Promise<void> | null = null;

  async send(delivery: ProviderDelivery) {
    this.calls.push(delivery);
    if (this.mode === "unknown") throw new UnknownAfterSendError("synthetic_acceptance_unknown");
    if (this.mode === "retryable") throw new RetryableDeliveryError("synthetic_rate_limit");
    if (this.mode === "permanent") throw new PermanentDeliveryError("synthetic_invalid_destination");
    if (this.mode === "blocking") {
      this.entered?.();
      await this.release;
    }
    return { providerMessageId: `synthetic-${this.calls.length}` };
  }
}

before(async () => database.$connect());
after(async () => database.$disconnect());
beforeEach(async () => {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation,
      safety_control_revisions, safety_control_mutations RESTART IDENTITY CASCADE
  `);
  await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  await setControl("feature_flag", "feature.channel_delivery", "channel", "apns", true);
  await setControl("kill_switch", "global.proactive_messages", "global", "*", false);
  await setControl("kill_switch", "channel.delivery", "channel", "apns", false);
});

async function setControl(
  type: "feature_flag" | "kill_switch",
  key: "feature.channel_delivery" | "global.proactive_messages" | "channel.delivery",
  scopeType: "global" | "channel",
  scopeId: "*" | "apns" | "wecom",
  active: boolean,
) {
  await database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    const version = await tx.safetyControlRevision.count({
      where: { controlType: type, controlKey: key, scopeType, scopeId },
    }) + 1;
    await tx.safetyControlRevision.create({ data: {
      controlType: type,
      controlKey: key,
      scopeType,
      scopeId,
      active,
      version,
      reason: "synthetic_test",
      adminActorId: randomUUID(),
      correlationId: randomUUID(),
    } });
    await tx.safetyControlEpoch.update({
      where: { id: "global" },
      data: { version: { increment: 1 } },
    });
  });
}

async function duePlan(now = new Date()) {
  const scheduledAt = new Date(now);
  scheduledAt.setUTCSeconds(0, 0);
  const minute = scheduledAt.getUTCHours() * 60 + scheduledAt.getUTCMinutes();
  const date = new Date(`${scheduledAt.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const preferenceAt = new Date(scheduledAt.getTime() - 60_000);
  const user = await database.user.create({ data: { timezone: "UTC", consentEpoch: 1 } });
  await database.device.create({ data: {
    userId: user.id,
    deviceId: "synthetic-ios",
    apnsTokenEncrypted: "synthetic-ciphertext-not-a-token",
    apnsTokenFingerprint: randomUUID().replaceAll("-", "").repeat(2),
    apnsTokenEpoch: 1,
    lastSeenAt: now,
  } });
  await database.consentRecord.create({ data: {
    userId: user.id,
    consentType: "notifications",
    documentVersion: "synthetic-notifications-v1",
    granted: true,
    epoch: 1,
    correlationId: randomUUID(),
    requestHash: randomUUID(),
    source: "synthetic",
  } });
  const preference = await database.reminderPreference.create({ data: {
    userId: user.id,
    version: 1,
    enabled: true,
    intensity: "standard",
    quietStartMinute: (minute + 60) % 1440,
    quietEndMinute: (minute + 120) % 1440,
    advisorMinute: minute,
    behaviorMinute: minute,
    weeklyDay: 1,
    weeklyMinute: 540,
    createdAt: preferenceAt,
    updatedAt: preferenceAt,
  } });
  await database.reminderPreferenceRevision.create({ data: {
    userId: user.id,
    version: 1,
    enabled: true,
    intensity: "standard",
    timezone: "UTC",
    quietStartMinute: preference.quietStartMinute,
    quietEndMinute: preference.quietEndMinute,
    advisorMinute: preference.advisorMinute,
    behaviorMinute: preference.behaviorMinute,
    weeklyDay: preference.weeklyDay,
    weeklyMinute: preference.weeklyMinute,
    effectiveAt: preferenceAt,
  } });
  const plan = await database.schedulePlan.create({ data: {
    userId: user.id,
    kind: "daily_advisor",
    localDate: date,
    periodStart: date,
    timezone: "UTC",
    scheduledAt,
    cutoffAt: new Date(scheduledAt.getTime() + 120 * 60_000),
    evaluatedAt: now,
    requestedMinute: minute,
    resolvedLocalMinute: minute,
    utcOffsetMinutes: 0,
    preferenceVersion: 1,
    notificationConsentEpoch: 1,
    status: "planned",
  } });
  return { now, plan, user };
}

function databaseWithSentAttemptFailure(): PrismaClient {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => callback(new Proxy(tx, {
            get(transaction, transactionProperty, transactionReceiver) {
              if (transactionProperty === "deliveryAttempt") {
                return new Proxy(transaction.deliveryAttempt, {
                  get(model, method, modelReceiver) {
                    if (method === "create") {
                      return async (args: Prisma.DeliveryAttemptCreateArgs) => {
                        if (args.data.status === "sent") {
                          throw new Error("synthetic_recording_failure_after_acceptance");
                        }
                        return model.create(args);
                      };
                    }
                    const value = Reflect.get(model, method, modelReceiver);
                    return typeof value === "function" ? value.bind(model) : value;
                  },
                });
              }
              const value = Reflect.get(transaction, transactionProperty, transactionReceiver);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          }) as Prisma.TransactionClient));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

function databaseWithExpiredLeaseScanRace(
  outboxId: string,
  observedLeaseToken: string,
  replacementLeaseToken: string,
  now: Date,
): PrismaClient {
  let raced = false;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "channelOutbox") {
        return new Proxy(target.channelOutbox, {
          get(model, method, modelReceiver) {
            if (method === "findMany") {
              return async (args: Prisma.ChannelOutboxFindManyArgs) => {
                const rows = await target.channelOutbox.findMany(args);
                if (!raced) {
                  raced = true;
                  await target.$transaction(async (tx) => {
                    await tx.$queryRaw`
                      SELECT "id" FROM "channel_outbox"
                      WHERE "id" = ${outboxId}::uuid FOR UPDATE
                    `;
                    await tx.$executeRaw`
                      SELECT set_config('healthos.channel_lease_token', ${observedLeaseToken}, true)
                    `;
                    await tx.channelOutbox.update({
                      where: { id: outboxId },
                      data: { status: "pending", availableAt: now },
                    });
                  });
                  await target.channelOutbox.update({
                    where: { id: outboxId },
                    data: {
                      status: "leased",
                      leaseToken: replacementLeaseToken,
                      leaseUntil: new Date(now.getTime() + 60_000),
                    },
                  });
                }
                return rows;
              };
            }
            const value = Reflect.get(model, method, modelReceiver);
            return typeof value === "function" ? value.bind(model) : value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

async function createWeComOutbox(now = new Date()) {
  const { plan, user } = await duePlan(now);
  await setControl("feature_flag", "feature.channel_delivery", "channel", "wecom", true);
  await setControl("kill_switch", "channel.delivery", "channel", "wecom", false);
  const account = await database.channelAccount.create({ data: {
    userId: user.id,
    channel: "wecom",
    tenantId: `tenant-${randomUUID()}`,
    externalIdLookupHmac: randomUUID().replaceAll("-", "").repeat(2),
    externalIdEncrypted: "synthetic-ciphertext",
    consentEpoch: 1,
    status: "linked",
    linkedAt: now,
  } });
  const payload = renderChannelTemplate("daily_advisor", "/today");
  const outbox = await database.channelOutbox.create({ data: {
    userId: user.id,
    channel: "wecom",
    template: payload.template,
    payload,
    idempotencyKey: `schedule:${plan.id}:wecom`,
    destinationId: account.id,
    destinationFingerprint: account.externalIdLookupHmac,
    destinationEpoch: account.consentEpoch,
    destinationTenantId: account.tenantId,
    schedulePlanId: plan.id,
    availableAt: plan.scheduledAt,
    consentRequirements: { create: { purpose: "notifications", grantEpoch: 1 } },
  } });
  return { account, now, outbox, user };
}

async function assertMutationWaitsAtProviderBoundary(
  worker: ChannelDeliveryWorker,
  provider: SyntheticProvider,
  outboxId: string,
  now: Date,
  mutate: () => Promise<unknown>,
) {
  provider.mode = "blocking";
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  provider.entered = enteredResolve;
  provider.release = new Promise<void>((resolve) => { releaseResolve = resolve; });

  const delivery = worker.deliverOne(outboxId, now);
  await entered;
  let mutationCompleted = false;
  const mutation = mutate().then(() => { mutationCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mutationCompleted, false);
  releaseResolve();
  assert.equal(await delivery, "sent");
  await mutation;
  assert.equal(mutationCompleted, true);
  assert.equal(provider.calls.length, 1);
}

async function waitUntilLeased(tx: Prisma.TransactionClient, outboxId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await tx.channelOutbox.findUniqueOrThrow({ where: { id: outboxId } });
    if (state.status === "leased") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("delivery did not acquire its lease");
}

test("enqueues one allowlisted APNs outbox and duplicate workers invoke the provider once", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });

  assert.equal(await worker.enqueueDueSchedules(now), 1);
  assert.equal(await worker.enqueueDueSchedules(now), 0);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  const results = await Promise.all(Array.from({ length: 20 }, () => worker.deliverOne(outbox.id, now)));

  assert.equal(results.filter((result) => result === "sent").length, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal((await database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "sent");
  assert.equal(await database.deliveryAttempt.count({ where: { outboxId: outbox.id } }), 1);
  assert.deepEqual(Object.keys(provider.calls[0]!.payload).sort(), [
    "action_key", "copy_key", "deeplink_path", "schema_version", "template",
  ]);
});

test("suppresses at the final boundary when notification consent changed after queueing", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.consentRecord.create({ data: {
    userId: user.id,
    consentType: "notifications",
    documentVersion: "synthetic-notifications-v2",
    granted: false,
    epoch: 2,
    correlationId: randomUUID(),
    requestHash: randomUUID(),
    source: "synthetic",
  } });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("fails closed when the channel feature revision is missing", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.safetyControlRevision.deleteMany({
      where: { controlType: "feature_flag", controlKey: "feature.channel_delivery" },
    });
  });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("records unknown_after_send and never retries provider acceptance with an unknown commit", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  provider.mode = "unknown";
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  assert.equal(await worker.deliverOne(outbox.id, now), "unknown_after_send");
  assert.equal(await worker.deliverOne(outbox.id, now), "not_claimed");
  assert.equal(provider.calls.length, 1);
  assert.equal((await database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "unknown_after_send");
});

test("records unknown when the provider accepts but delivery evidence cannot be committed", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(
    databaseWithSentAttemptFailure(),
    { apns: provider, wecom: provider },
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  assert.equal(await worker.deliverOne(outbox.id, now), "unknown_after_send");
  assert.equal(await worker.deliverOne(outbox.id, now), "not_claimed");
  assert.equal(provider.calls.length, 1);
  assert.equal((await database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "unknown_after_send");
  const attempts = await database.deliveryAttempt.findMany({ where: { outboxId: outbox.id } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, "unknown_after_send");
});

test("suppresses an already queued delivery when its schedule cutoff has passed", async () => {
  const { now, plan } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(
    database,
    { apns: provider, wecom: provider },
    { clock: () => new Date(plan.cutoffAt.getTime() + 1) } as never,
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("rechecks a fresh clock immediately before provider invocation", async () => {
  const { now, plan } = await duePlan();
  let reads = 0;
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(
    database,
    { apns: provider, wecom: provider },
    {
      leaseSeconds: 4 * 60 * 60,
      clock: () => reads++ === 0
        ? new Date(plan.cutoffAt.getTime() - 1)
        : new Date(plan.cutoffAt.getTime() + 1),
    },
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
  assert.ok(reads >= 2);
});

test("never revives a retry after the schedule cutoff", async () => {
  const { now, plan } = await duePlan();
  let boundaryAt = now;
  const provider = new SyntheticProvider();
  provider.mode = "retryable";
  const worker = new ChannelDeliveryWorker(
    database,
    { apns: provider, wecom: provider },
    { retrySeconds: 10, clock: () => boundaryAt },
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  assert.equal(await worker.deliverOne(outbox.id, now), "retry_scheduled");

  boundaryAt = new Date(plan.cutoffAt.getTime() + 1);
  provider.mode = "sent";
  assert.equal(await worker.deliverOne(outbox.id, boundaryAt), "suppressed");
  assert.equal(provider.calls.length, 1);
});

test("rechecks privacy and destination revisions immediately before invocation", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const first = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "required" } });
  assert.equal(await worker.deliverOne(first.id, now), "suppressed");

  await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
  const secondPlan = await duePlan();
  await worker.enqueueDueSchedules(secondPlan.now);
  const second = await database.channelOutbox.findFirstOrThrow({
    where: { channel: "apns", id: { not: first.id } },
  });
  await database.device.update({
    where: { id: second.destinationId! },
    data: { apnsTokenFingerprint: "c".repeat(64), apnsTokenEncrypted: "rotated-synthetic-ciphertext" },
  });
  assert.equal(await worker.deliverOne(second.id, secondPlan.now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("retries only explicit not-accepted failures and terminally fails bounded attempts", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  provider.mode = "retryable";
  const worker = new ChannelDeliveryWorker(
    database,
    { apns: provider, wecom: provider },
    { maxAttempts: 2, retrySeconds: 10 },
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  assert.equal(await worker.deliverOne(outbox.id, now), "retry_scheduled");
  assert.equal(await worker.deliverOne(outbox.id, new Date(now.getTime() + 1)), "not_claimed");
  assert.equal(await worker.deliverOne(outbox.id, new Date(now.getTime() + 10_001)), "failed");
  assert.equal(provider.calls.length, 2);
  assert.equal(await database.deliveryAttempt.count({ where: { outboxId: outbox.id } }), 2);
});

test("never invokes a provider or commits sent after its lease has expired", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(
    database,
    { apns: provider, wecom: provider },
    { leaseSeconds: -1 },
  );
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("holds the epoch lock through provider invocation so concurrent switch activation cannot cross", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  provider.mode = "blocking";
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  provider.entered = enteredResolve;
  provider.release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });

  const delivery = worker.deliverOne(outbox.id, now);
  await entered;
  let activated = false;
  const activation = setControl("kill_switch", "channel.delivery", "channel", "apns", true)
    .then(() => { activated = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(activated, false);
  releaseResolve();
  assert.equal(await delivery, "sent");
  await activation;
  assert.equal(activated, true);
});

test("reconciles every expired in-flight lease as unknown instead of blindly resending", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.channelOutbox.update({
    where: { id: outbox.id },
    data: {
      status: "leased",
      leaseToken: randomUUID(),
      leaseUntil: new Date(now.getTime() - 1),
    },
  });

  assert.equal(await worker.reconcileExpiredLeases(now), 1);
  assert.equal(await worker.deliverOne(outbox.id, now), "not_claimed");
  assert.equal(provider.calls.length, 0);
  assert.equal((await database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, "unknown_after_send");
});

test("does not reconcile an expired lease after the row is re-leased with a new token", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const enqueueWorker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await enqueueWorker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  const observedLeaseToken = randomUUID();
  const replacementLeaseToken = randomUUID();
  await database.channelOutbox.update({
    where: { id: outbox.id },
    data: {
      status: "leased",
      leaseToken: observedLeaseToken,
      leaseUntil: new Date(now.getTime() - 1),
    },
  });
  const racingDatabase = databaseWithExpiredLeaseScanRace(
    outbox.id,
    observedLeaseToken,
    replacementLeaseToken,
    now,
  );
  const reconcileWorker = new ChannelDeliveryWorker(
    racingDatabase,
    { apns: provider, wecom: provider },
  );

  assert.equal(await reconcileWorker.reconcileExpiredLeases(now), 0);
  const current = await database.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
  assert.equal(current.status, "leased");
  assert.equal(current.leaseToken, replacementLeaseToken);
  assert.ok(current.leaseUntil && current.leaseUntil > now);
  assert.equal(await database.deliveryAttempt.count({ where: { outboxId: outbox.id } }), 0);
  assert.equal(provider.calls.length, 0);
});

test("suppresses a queued reminder after the user disables the current preference", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    const current = await tx.reminderPreference.findUniqueOrThrow({ where: { userId: user.id } });
    const updatedAt = new Date(current.updatedAt.getTime() + 1);
    const updated = await tx.reminderPreference.update({
      where: { userId: user.id },
      data: { enabled: false, version: 2, updatedAt },
    });
    await tx.reminderPreferenceRevision.create({ data: {
      userId: user.id,
      version: 2,
      enabled: false,
      intensity: updated.intensity,
      timezone: "UTC",
      quietStartMinute: updated.quietStartMinute,
      quietEndMinute: updated.quietEndMinute,
      advisorMinute: updated.advisorMinute,
      behaviorMinute: updated.behaviorMinute,
      weeklyDay: updated.weeklyDay,
      weeklyMinute: updated.weeklyMinute,
      effectiveAt: updatedAt,
    } });
  });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("suppresses the prior account after an atomic APNs token ownership transfer", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({
    where: { channel: "apns", userId: user.id },
  });
  const priorDevice = await database.device.findUniqueOrThrow({ where: { id: outbox.destinationId! } });
  const nextUser = await database.user.create({ data: { timezone: "UTC" } });
  const nextDeviceId = "synthetic-account-switch-device";

  await database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "healthos_claim_apns_token"(
        ${nextUser.id}::uuid,
        ${nextDeviceId},
        ${"synthetic-transferred-ciphertext"},
        ${priorDevice.apnsTokenFingerprint},
        ${"1.0.0"}
      )
    `;
  });

  const revoked = await database.device.findUniqueOrThrow({ where: { id: priorDevice.id } });
  assert.equal(revoked.apnsTokenEncrypted, null);
  assert.equal(revoked.apnsTokenFingerprint, null);
  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("never revalidates a pre-transfer APNs outbox after ownership returns to the prior account", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({
    where: { channel: "apns", userId: user.id },
  });
  const priorDevice = await database.device.findUniqueOrThrow({ where: { id: outbox.destinationId! } });
  const fingerprint = priorDevice.apnsTokenFingerprint!;
  const nextUser = await database.user.create({ data: { timezone: "UTC" } });

  await database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "healthos_claim_apns_token"(
        ${nextUser.id}::uuid,
        ${"synthetic-aba-next-device"},
        ${"synthetic-aba-next-ciphertext"},
        ${fingerprint},
        ${"1.0.0"}
      )
    `;
  });
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "healthos_claim_apns_token"(
        ${user.id}::uuid,
        ${priorDevice.deviceId},
        ${"synthetic-aba-returned-ciphertext"},
        ${fingerprint},
        ${"1.0.1"}
      )
    `;
  });

  const returnedDevice = await database.device.findUniqueOrThrow({ where: { id: priorDevice.id } });
  assert.equal(outbox.destinationEpoch, 1);
  assert.equal(returnedDevice.apnsTokenEpoch, 2);
  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("does not enqueue after the current reminder preference is disabled", async () => {
  const { now, user } = await duePlan();
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    const current = await tx.reminderPreference.findUniqueOrThrow({ where: { userId: user.id } });
    const updatedAt = new Date(current.updatedAt.getTime() + 1);
    const updated = await tx.reminderPreference.update({
      where: { userId: user.id },
      data: { enabled: false, version: 2, updatedAt },
    });
    await tx.reminderPreferenceRevision.create({ data: {
      userId: user.id,
      version: 2,
      enabled: false,
      intensity: updated.intensity,
      timezone: "UTC",
      quietStartMinute: updated.quietStartMinute,
      quietEndMinute: updated.quietEndMinute,
      advisorMinute: updated.advisorMinute,
      behaviorMinute: updated.behaviorMinute,
      weeklyDay: updated.weeklyDay,
      weeklyMinute: updated.weeklyMinute,
      effectiveAt: updatedAt,
    } });
  });
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });

  assert.equal(await worker.enqueueDueSchedules(now), 0);
  assert.equal(await database.channelOutbox.count({ where: { userId: user.id } }), 0);
});

test("serializes enqueue behind a preference disable committed before outbox insertion", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  let enqueue: Promise<number> | null = null;
  let enqueueSettled = false;

  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    enqueue = worker.enqueueDueSchedules(now).then((result) => {
      enqueueSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(enqueueSettled, false);

    const current = await tx.reminderPreference.findUniqueOrThrow({ where: { userId: user.id } });
    const updatedAt = new Date(current.updatedAt.getTime() + 1);
    const updated = await tx.reminderPreference.update({
      where: { userId: user.id },
      data: { enabled: false, version: 2, updatedAt },
    });
    await tx.reminderPreferenceRevision.create({ data: {
      userId: user.id,
      version: 2,
      enabled: false,
      intensity: updated.intensity,
      timezone: "UTC",
      quietStartMinute: updated.quietStartMinute,
      quietEndMinute: updated.quietEndMinute,
      advisorMinute: updated.advisorMinute,
      behaviorMinute: updated.behaviorMinute,
      weeklyDay: updated.weeklyDay,
      weeklyMinute: updated.weeklyMinute,
      effectiveAt: updatedAt,
    } });
  });

  assert.ok(enqueue);
  assert.equal(await enqueue, 0);
  assert.equal(await database.channelOutbox.count({ where: { userId: user.id } }), 0);
});

test("binds WeCom delivery to the exact tenant as well as account, HMAC, and epoch", async () => {
  const { now, plan, user } = await duePlan();
  await setControl("feature_flag", "feature.channel_delivery", "channel", "wecom", true);
  await setControl("kill_switch", "channel.delivery", "channel", "wecom", false);
  const account = await database.channelAccount.create({ data: {
    userId: user.id,
    channel: "wecom",
    tenantId: "tenant-before",
    externalIdLookupHmac: "b".repeat(64),
    externalIdEncrypted: "synthetic-ciphertext",
    consentEpoch: 1,
    status: "linked",
    linkedAt: now,
  } });
  const payload = renderChannelTemplate("daily_advisor", "/today");
  const outbox = await database.channelOutbox.create({ data: {
    userId: user.id,
    channel: "wecom",
    template: payload.template,
    payload,
    idempotencyKey: `schedule:${plan.id}:wecom`,
    destinationId: account.id,
    destinationFingerprint: account.externalIdLookupHmac,
    destinationEpoch: account.consentEpoch,
    destinationTenantId: account.tenantId,
    schedulePlanId: plan.id,
    availableAt: plan.scheduledAt,
    consentRequirements: { create: { purpose: "notifications", grantEpoch: 1 } },
  } });
  await database.channelAccount.update({ where: { id: account.id }, data: { tenantId: "tenant-after" } });
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });

  assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
  assert.equal(provider.calls.length, 0);
});

test("fails closed for every WeCom binding field when it changes before delivery", async () => {
  const mutations: Array<(accountId: string) => Promise<unknown>> = [
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { tenantId: `rotated-${randomUUID()}` },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { externalIdLookupHmac: "c".repeat(64) },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { consentEpoch: { increment: 1 } },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { status: "revoked" },
    }),
  ];

  for (const mutate of mutations) {
    const { account, now, outbox } = await createWeComOutbox();
    await mutate(account.id);
    const provider = new SyntheticProvider();
    const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
    assert.equal(await worker.deliverOne(outbox.id, now), "suppressed");
    assert.equal(provider.calls.length, 0);
  }
});

test("serializes consent, deletion, privacy, and APNs rotation at the provider boundary", async () => {
  const scenarios: Array<(
    userId: string,
    destinationId: string,
  ) => Promise<unknown>> = [
    (userId) => database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      await tx.consentRecord.create({ data: {
        userId,
        consentType: "notifications",
        documentVersion: "synthetic-concurrent-withdrawal",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      } });
      await tx.user.update({ where: { id: userId }, data: { consentEpoch: 2 } });
    }),
    (userId) => database.user.update({
      where: { id: userId }, data: { status: "deleting", deletedAt: new Date() },
    }),
    async () => database.privacyReconciliation.update({
      where: { id: "global" }, data: { status: "required" },
    }),
    async (_userId, destinationId) => database.device.update({
      where: { id: destinationId },
      data: { apnsTokenFingerprint: "d".repeat(64), apnsTokenEncrypted: null },
    }),
  ];

  for (const mutate of scenarios) {
    const { now, user } = await duePlan();
    const provider = new SyntheticProvider();
    const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
    await worker.enqueueDueSchedules(now);
    const outbox = await database.channelOutbox.findFirstOrThrow({
      where: { channel: "apns", userId: user.id },
    });
    await assertMutationWaitsAtProviderBoundary(
      worker,
      provider,
      outbox.id,
      now,
      () => mutate(user.id, outbox.destinationId!),
    );
    if ((await database.privacyReconciliation.findUniqueOrThrow({ where: { id: "global" } })).status !== "ready") {
      await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
    }
  }
});

test("serializes every WeCom binding mutation at the provider boundary", async () => {
  const mutations: Array<(accountId: string) => Promise<unknown>> = [
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { tenantId: `rotated-${randomUUID()}` },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { externalIdLookupHmac: "e".repeat(64) },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { consentEpoch: { increment: 1 } },
    }),
    (accountId) => database.channelAccount.update({
      where: { id: accountId }, data: { status: "revoked" },
    }),
  ];

  for (const mutate of mutations) {
    const { account, now, outbox } = await createWeComOutbox();
    const provider = new SyntheticProvider();
    const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
    await assertMutationWaitsAtProviderBoundary(
      worker,
      provider,
      outbox.id,
      now,
      () => mutate(account.id),
    );
  }
});

test("mutation-first deletion, privacy, APNs rotation, and kill switch never invoke a provider", async () => {
  const scenarios: Array<(
    tx: Prisma.TransactionClient,
    context: { userId: string; destinationId: string; start: () => void },
  ) => Promise<void>> = [
    async (tx, { userId, start }) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      start();
      await tx.user.update({
        where: { id: userId }, data: { status: "deleting", deletedAt: new Date() },
      });
    },
    async (tx, { start }) => {
      await tx.$queryRaw`SELECT "id" FROM "privacy_reconciliation" WHERE "id" = 'global' FOR UPDATE`;
      start();
      await tx.privacyReconciliation.update({ where: { id: "global" }, data: { status: "required" } });
    },
    async (tx, { destinationId, start }) => {
      await tx.$queryRaw`SELECT "id" FROM "devices" WHERE "id" = ${destinationId}::uuid FOR UPDATE`;
      start();
      await tx.device.update({
        where: { id: destinationId },
        data: { apnsTokenFingerprint: "f".repeat(64), apnsTokenEncrypted: null },
      });
    },
    async (tx, { start }) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$queryRaw`SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR UPDATE`;
      start();
      const version = await tx.safetyControlRevision.count({
        where: {
          controlType: "kill_switch",
          controlKey: "channel.delivery",
          scopeType: "channel",
          scopeId: "apns",
        },
      }) + 1;
      await tx.safetyControlRevision.create({ data: {
        controlType: "kill_switch",
        controlKey: "channel.delivery",
        scopeType: "channel",
        scopeId: "apns",
        active: true,
        version,
        reason: "synthetic_test",
        adminActorId: randomUUID(),
        correlationId: randomUUID(),
      } });
      await tx.safetyControlEpoch.update({ where: { id: "global" }, data: { version: { increment: 1 } } });
    },
  ];

  for (const scenario of scenarios) {
    const { now, user } = await duePlan();
    const provider = new SyntheticProvider();
    const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
    await worker.enqueueDueSchedules(now);
    const outbox = await database.channelOutbox.findFirstOrThrow({
      where: { channel: "apns", userId: user.id },
    });
    let delivery!: Promise<unknown>;
    await database.$transaction(async (tx) => {
      await scenario(tx, {
        userId: user.id,
        destinationId: outbox.destinationId!,
        start: () => { delivery = worker.deliverOne(outbox.id, now); },
      });
      await waitUntilLeased(tx, outbox.id);
    });
    assert.equal(await delivery, "suppressed");
    assert.equal(provider.calls.length, 0);
    if ((await database.privacyReconciliation.findUniqueOrThrow({ where: { id: "global" } })).status !== "ready") {
      await database.privacyReconciliation.update({ where: { id: "global" }, data: { status: "ready" } });
    }
    const activeStop = await database.safetyControlRevision.findFirst({
      where: {
        controlType: "kill_switch",
        controlKey: "channel.delivery",
        scopeType: "channel",
        scopeId: "apns",
      },
      orderBy: { version: "desc" },
    });
    if (activeStop?.active) {
      await setControl("kill_switch", "channel.delivery", "channel", "apns", false);
    }
  }
});

test("mutation-first WeCom tenant, HMAC, epoch, and status changes never invoke a provider", async () => {
  const mutations: Array<(tx: Prisma.TransactionClient, accountId: string) => Promise<unknown>> = [
    (tx, accountId) => tx.channelAccount.update({
      where: { id: accountId }, data: { tenantId: `rotated-${randomUUID()}` },
    }),
    (tx, accountId) => tx.channelAccount.update({
      where: { id: accountId }, data: { externalIdLookupHmac: "1".repeat(64) },
    }),
    (tx, accountId) => tx.channelAccount.update({
      where: { id: accountId }, data: { consentEpoch: { increment: 1 } },
    }),
    (tx, accountId) => tx.channelAccount.update({
      where: { id: accountId }, data: { status: "revoked" },
    }),
  ];

  for (const mutate of mutations) {
    const { account, now, outbox } = await createWeComOutbox();
    const provider = new SyntheticProvider();
    const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
    let delivery!: Promise<unknown>;
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "channel_accounts" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
      delivery = worker.deliverOne(outbox.id, now);
      await waitUntilLeased(tx, outbox.id);
      await mutate(tx, account.id);
    });
    assert.equal(await delivery, "suppressed");
    assert.equal(provider.calls.length, 0);
  }
});

test("serializes concurrent expired-lease reconcilers without duplicate evidence", async () => {
  const { now } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  await database.channelOutbox.update({
    where: { id: outbox.id },
    data: { status: "leased", leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() - 1) },
  });

  const results = await Promise.all(Array.from({ length: 20 }, () => worker.reconcileExpiredLeases(now)));
  assert.equal(results.reduce((sum, result) => sum + result, 0), 1);
  assert.equal(await database.deliveryAttempt.count({ where: { outboxId: outbox.id } }), 1);
});

test("rereads user, consent, and outbox after waiting behind a concurrent withdrawal lock", async () => {
  const { now, user } = await duePlan();
  const provider = new SyntheticProvider();
  const worker = new ChannelDeliveryWorker(database, { apns: provider, wecom: provider });
  await worker.enqueueDueSchedules(now);
  const outbox = await database.channelOutbox.findFirstOrThrow({ where: { channel: "apns" } });
  let delivery!: Promise<unknown>;

  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
    delivery = worker.deliverOne(outbox.id, now);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await tx.channelOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
      if (state.status === "leased") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await tx.consentRecord.create({ data: {
      userId: user.id,
      consentType: "notifications",
      documentVersion: "synthetic-withdrawal-v2",
      granted: false,
      epoch: 2,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    } });
    await tx.user.update({ where: { id: user.id }, data: { consentEpoch: 2 } });
    await tx.channelOutbox.update({ where: { id: outbox.id }, data: { status: "suppressed" } });
  });

  assert.equal(await delivery, "suppressed");
  assert.equal(provider.calls.length, 0);
});
