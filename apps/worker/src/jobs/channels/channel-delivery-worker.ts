import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  parseChannelTemplate,
  renderChannelTemplate,
  type ChannelTemplatePayload,
  type ScheduleNotificationKind,
} from "./channel-template";

export type ProviderDelivery = {
  channel: "apns" | "wecom";
  destinationId: string;
  idempotencyKey: string;
  payload: ChannelTemplatePayload;
};

export interface ChannelProvider {
  send(delivery: ProviderDelivery): Promise<{ providerMessageId: string }>;
}

export class RetryableDeliveryError extends Error {
  constructor(readonly errorCode: string) {
    super(normalizeErrorCode(errorCode));
    this.errorCode = normalizeErrorCode(errorCode);
  }
}

export class PermanentDeliveryError extends Error {
  constructor(readonly errorCode: string) {
    super(normalizeErrorCode(errorCode));
    this.errorCode = normalizeErrorCode(errorCode);
  }
}

export class UnknownAfterSendError extends Error {
  constructor(readonly errorCode: string) {
    super(normalizeErrorCode(errorCode));
    this.errorCode = normalizeErrorCode(errorCode);
  }
}

function normalizeErrorCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "provider_error";
}

type DeliveryResult =
  | "sent"
  | "suppressed"
  | "retry_scheduled"
  | "failed"
  | "unknown_after_send"
  | "not_claimed";

const PATH_BY_KIND: Readonly<Record<ScheduleNotificationKind, "/today" | "/review">> = {
  daily_advisor: "/today",
  behavior_reminder: "/today",
  weekly_review: "/review",
};

export class ChannelDeliveryWorker {
  constructor(
    private readonly database: PrismaClient,
    private readonly providers: Readonly<Record<"apns" | "wecom", ChannelProvider>>,
    private readonly config: {
      leaseSeconds?: number;
      maxAttempts?: number;
      retrySeconds?: number;
      clock?: () => Date;
      enabled?: boolean;
    } = {},
  ) {}

  async enqueueDueSchedules(now: Date): Promise<number> {
    if (this.config.enabled === false) return 0;
    const plans = await this.database.schedulePlan.findMany({
      where: {
        status: "planned",
        scheduledAt: { lte: now },
        cutoffAt: { gte: now },
        notificationConsentEpoch: { not: null },
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    });
    let inserted = 0;
    for (const plan of plans) {
      try {
        const created = await this.database.$transaction(async (tx) => {
          const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "users" WHERE "id" = ${plan.userId}::uuid FOR SHARE
          `;
          if (lockedUsers.length !== 1) return false;
          await tx.$queryRaw`
            SELECT "user_id" FROM "reminder_preferences"
            WHERE "user_id" = ${plan.userId}::uuid FOR SHARE
          `;
          await tx.$queryRaw`
            SELECT "id" FROM "schedule_plans" WHERE "id" = ${plan.id}::uuid FOR SHARE
          `;
          const currentPlan = await tx.schedulePlan.findUnique({ where: { id: plan.id } });
          if (
            !currentPlan
            || currentPlan.status !== "planned"
            || currentPlan.scheduledAt > now
            || currentPlan.cutoffAt < now
            || currentPlan.notificationConsentEpoch === null
            || !(currentPlan.kind in PATH_BY_KIND)
          ) {
            return false;
          }
          const preference = await tx.reminderPreference.findUnique({
            where: { userId: currentPlan.userId },
            select: { enabled: true, version: true },
          });
          if (!preference?.enabled || preference.version !== currentPlan.preferenceVersion) {
            return false;
          }
          const device = await tx.device.findFirst({
            where: {
              userId: currentPlan.userId,
              apnsTokenEncrypted: { not: null },
              apnsTokenFingerprint: { not: null },
            },
            orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
          });
          if (!device?.apnsTokenFingerprint || !/^[a-f0-9]{64}$/.test(device.apnsTokenFingerprint)) {
            return false;
          }
          const kind = currentPlan.kind as ScheduleNotificationKind;
          const payload = renderChannelTemplate(kind, PATH_BY_KIND[kind]);
          await tx.channelOutbox.create({ data: {
            userId: currentPlan.userId,
            channel: "apns",
            template: payload.template,
            payload,
            idempotencyKey: `schedule:${currentPlan.id}:apns`,
            destinationId: device.id,
            destinationFingerprint: device.apnsTokenFingerprint,
            destinationEpoch: device.apnsTokenEpoch,
            schedulePlanId: currentPlan.id,
            availableAt: currentPlan.scheduledAt,
            consentRequirements: {
              create: {
                purpose: "notifications",
                grantEpoch: currentPlan.notificationConsentEpoch,
              },
            },
          } });
          return true;
        });
        if (created) inserted += 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          continue;
        }
        throw error;
      }
    }
    return inserted;
  }

  async reconcileExpiredLeases(now: Date): Promise<number> {
    if (this.config.enabled === false) return 0;
    const expired = await this.database.channelOutbox.findMany({
      where: { status: "leased", leaseUntil: { lt: now }, channel: { in: ["apns", "wecom"] } },
      select: { id: true, leaseToken: true, leaseUntil: true },
    });
    let reconciled = 0;
    for (const outbox of expired) {
      if (!outbox.leaseToken || !outbox.leaseUntil) continue;
      const result = await this.finalize(
        outbox.id,
        outbox.leaseToken,
        "unknown_after_send",
        "expired_lease_delivery_unknown",
        now,
        undefined,
        now,
      );
      if (result) reconciled += 1;
    }
    return reconciled;
  }

  async deliverOne(outboxId: string, now: Date = new Date()): Promise<DeliveryResult> {
    if (this.config.enabled === false) return "not_claimed";
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + (this.config.leaseSeconds ?? 30) * 1_000);
    const claimed = await this.database.channelOutbox.updateMany({
      where: {
        id: outboxId,
        status: "pending",
        availableAt: { lte: now },
      },
      data: { status: "leased", leaseToken, leaseUntil },
    });
    if (claimed.count !== 1) return "not_claimed";

    try {
      return await this.database.$transaction(async (tx) => {
        const [epoch] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "safety_control_epoch" WHERE "id" = 'global' FOR SHARE
        `;
        const identity = await tx.channelOutbox.findUnique({
          where: { id: outboxId },
          select: { userId: true, channel: true, destinationId: true },
        });
        if (!identity) return "suppressed";
        if (!epoch) {
          return this.suppressInTransaction(tx, outboxId, leaseToken);
        }
        if (identity.channel !== "apns" && identity.channel !== "wecom") {
          return this.suppressInTransaction(tx, outboxId, leaseToken);
        }
        const channel = identity.channel;
        await tx.$queryRaw`
          SELECT "id" FROM "users" WHERE "id" = ${identity.userId}::uuid FOR SHARE
        `;
        await tx.$queryRaw`
          SELECT "id" FROM "privacy_reconciliation" WHERE "id" = 'global' FOR SHARE
        `;
        await tx.$queryRaw`
          SELECT "user_id" FROM "reminder_preferences"
          WHERE "user_id" = ${identity.userId}::uuid FOR SHARE
        `;
        if (identity.destinationId) {
          if (channel === "apns") {
            await tx.$queryRaw`
              SELECT "id" FROM "devices"
              WHERE "id" = ${identity.destinationId}::uuid FOR SHARE
            `;
          } else {
            await tx.$queryRaw`
              SELECT "id" FROM "channel_accounts"
              WHERE "id" = ${identity.destinationId}::uuid FOR SHARE
            `;
          }
        }
        const outbox = await tx.channelOutbox.findUnique({
          where: { id: outboxId },
          include: {
            consentRequirements: true,
            schedulePlan: true,
            user: { include: { consents: true } },
          },
        });
        if (!outbox) return "suppressed";
        if (outbox.status !== "leased" || outbox.leaseToken !== leaseToken) {
          return this.suppressInTransaction(tx, outboxId, leaseToken);
        }
        const [privacy, feature, globalStop, channelStop] = await Promise.all([
          tx.privacyReconciliation.findUnique({ where: { id: "global" } }),
          tx.safetyControlRevision.findFirst({
            where: {
              controlType: "feature_flag",
              controlKey: "feature.channel_delivery",
              scopeType: "channel",
              scopeId: channel,
            },
            orderBy: { version: "desc" },
          }),
          tx.safetyControlRevision.findFirst({
            where: {
              controlType: "kill_switch",
              controlKey: "global.proactive_messages",
              scopeType: "global",
              scopeId: "*",
            },
            orderBy: { version: "desc" },
          }),
          tx.safetyControlRevision.findFirst({
            where: {
              controlType: "kill_switch",
              controlKey: "channel.delivery",
              scopeType: "channel",
              scopeId: channel,
            },
            orderBy: { version: "desc" },
          }),
        ]);
        const notificationRequirement = outbox.consentRequirements.length === 1
          ? outbox.consentRequirements[0]
          : null;
        const currentNotification = outbox.user.consents
          .filter((consent) => consent.consentType === "notifications")
          .sort((left, right) => right.epoch - left.epoch)[0];
        const boundaryAt = this.config.clock?.() ?? new Date();
        const authorized =
          outbox.user.status === "active" &&
          privacy?.status === "ready" &&
          feature?.active === true &&
          globalStop?.active === false &&
          channelStop?.active === false &&
          notificationRequirement?.purpose === "notifications" &&
          currentNotification?.granted === true &&
          currentNotification.epoch === notificationRequirement.grantEpoch &&
          outbox.leaseUntil !== null &&
          outbox.leaseUntil > boundaryAt &&
          outbox.schedulePlan !== null &&
          outbox.schedulePlan.cutoffAt >= boundaryAt &&
          await tx.reminderPreference.count({
            where: {
              userId: outbox.userId,
              enabled: true,
              version: outbox.schedulePlan.preferenceVersion,
            },
          }) === 1;
        if (!authorized || !outbox.destinationId || !outbox.destinationFingerprint) {
          return this.suppressInTransaction(tx, outboxId, leaseToken);
        }
        const destinationValid = channel === "apns"
          ? await tx.device.count({ where: {
              id: outbox.destinationId,
              userId: outbox.userId,
              apnsTokenEncrypted: { not: null },
              apnsTokenFingerprint: outbox.destinationFingerprint,
              apnsTokenEpoch: outbox.destinationEpoch ?? -1,
            } }) === 1
          : await tx.channelAccount.count({ where: {
              id: outbox.destinationId,
              userId: outbox.userId,
              channel: "wecom",
              status: "linked",
              tenantId: outbox.destinationTenantId ?? "",
              externalIdLookupHmac: outbox.destinationFingerprint,
              consentEpoch: outbox.destinationEpoch ?? -1,
            } }) === 1;
        if (!destinationValid) return this.suppressInTransaction(tx, outboxId, leaseToken);

        let payload: ChannelTemplatePayload;
        try {
          payload = parseChannelTemplate(outbox.payload);
          if (payload.template !== outbox.template) throw new Error("template mismatch");
        } catch {
          throw new PermanentDeliveryError("template_invalid");
        }
        const providerBoundaryAt = this.config.clock?.() ?? new Date();
        if (
          !outbox.leaseUntil ||
          outbox.leaseUntil <= providerBoundaryAt ||
          !outbox.schedulePlan ||
          outbox.schedulePlan.cutoffAt < providerBoundaryAt
        ) {
          return this.suppressInTransaction(tx, outboxId, leaseToken);
        }
        const provider = this.providers[channel];
        const result = await provider.send({
          channel,
          destinationId: outbox.destinationId,
          idempotencyKey: outbox.idempotencyKey,
          payload,
        });
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result.providerMessageId)) {
          throw new UnknownAfterSendError("provider_identifier_invalid");
        }
        const attempt = await tx.deliveryAttempt.count({ where: { outboxId } }) + 1;
        await tx.deliveryAttempt.create({ data: {
          outboxId,
          attempt,
          providerMessageId: result.providerMessageId,
          status: "sent",
          sentAt: now,
        } });
        await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${leaseToken}, true)`;
        const completed = await tx.channelOutbox.updateMany({
          where: { id: outboxId, status: "leased", leaseToken },
          data: { status: "sent" },
        });
        if (completed.count !== 1) throw new UnknownAfterSendError("stale_lease_after_acceptance");
        return "sent";
      });
    } catch (error) {
      if (error instanceof RetryableDeliveryError) {
        const attempts = await this.database.deliveryAttempt.count({ where: { outboxId } });
        const terminal = attempts + 1 >= (this.config.maxAttempts ?? 3);
        const status = terminal ? "failed" : "pending";
        const delaySeconds = (this.config.retrySeconds ?? 30) * (2 ** attempts);
        const retryAt = terminal ? undefined : new Date(now.getTime() + delaySeconds * 1_000);
        await this.finalize(outboxId, leaseToken, status, error.errorCode, now, retryAt);
        return terminal ? "failed" : "retry_scheduled";
      }
      if (error instanceof PermanentDeliveryError) {
        await this.finalize(outboxId, leaseToken, "failed", error.errorCode, now);
        return "failed";
      }
      const errorCode = error instanceof UnknownAfterSendError
        ? error.errorCode
        : "provider_result_unknown";
      await this.finalize(outboxId, leaseToken, "unknown_after_send", errorCode, now);
      return "unknown_after_send";
    }
  }

  private async suppressInTransaction(
    tx: Prisma.TransactionClient,
    outboxId: string,
    leaseToken: string,
  ): Promise<"suppressed"> {
    await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${leaseToken}, true)`;
    await tx.channelOutbox.updateMany({
      where: { id: outboxId, status: "leased", leaseToken },
      data: { status: "suppressed" },
    });
    return "suppressed";
  }

  private async finalize(
    outboxId: string,
    leaseToken: string,
    status: "pending" | "failed" | "unknown_after_send",
    errorCode: string,
    now: Date,
    availableAt?: Date,
    requireExpiredBefore?: Date,
  ): Promise<boolean> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "channel_outbox" WHERE "id" = ${outboxId}::uuid FOR UPDATE
      `;
      const outbox = await tx.channelOutbox.findUnique({ where: { id: outboxId } });
      if (!outbox || outbox.status !== "leased") return false;
      if (outbox.leaseToken !== leaseToken) return false;
      if (
        requireExpiredBefore
        && (!outbox.leaseUntil || outbox.leaseUntil >= requireExpiredBefore)
      ) {
        return false;
      }
      const attempt = await tx.deliveryAttempt.count({ where: { outboxId } }) + 1;
      await tx.$executeRaw`SELECT set_config('healthos.channel_lease_token', ${leaseToken}, true)`;
      const updated = await tx.channelOutbox.updateMany({
        where: {
          id: outboxId,
          status: "leased",
          leaseToken,
          ...(requireExpiredBefore ? { leaseUntil: { lt: requireExpiredBefore } } : {}),
        },
        data: { status, ...(availableAt ? { availableAt } : {}) },
      });
      if (updated.count !== 1) return false;
      await tx.deliveryAttempt.create({ data: {
        outboxId,
        attempt,
        status,
        errorCode,
        sentAt: status === "unknown_after_send" ? now : null,
      } });
      return true;
    });
  }
}
