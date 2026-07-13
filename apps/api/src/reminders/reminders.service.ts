import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ReminderPreferenceResponse } from "@healthos/contracts";
import type { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";
import type { ReminderPreferenceUpdateDto } from "./dto/reminder-preference.dto";
import { reminderPreferenceView, timeToMinute, weekdayNumber } from "./reminder-view";

function canonicalHash(value: ReminderPreferenceUpdateDto): string {
  return createHash("sha256").update(JSON.stringify({
    expected_version: value.expected_version,
    enabled: value.enabled,
    intensity: value.intensity,
    timezone: value.timezone,
    quiet_hours: { start: value.quiet_hours.start, end: value.quiet_hours.end },
    advisor_time: value.advisor_time,
    behavior_time: value.behavior_time,
    weekly_report: { day: value.weekly_report.day, time: value.weekly_report.time },
  })).digest("hex");
}

function isQuiet(minute: number, start: number, end: number): boolean {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new BadRequestException("Invalid IANA timezone");
  }
}

@Injectable()
export class RemindersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(userId: string): Promise<ReminderPreferenceResponse> {
    const [user, privacy] = await Promise.all([
      this.database.user.findUnique({ where: { id: userId }, include: { reminderPreference: true } }),
      this.database.privacyReconciliation.findUnique({ where: { id: "global" } }),
    ]);
    if (!user || user.status !== "active") throw new ForbiddenException("User processing is unavailable");
    if (privacy?.status !== "ready") throw new ServiceUnavailableException("Privacy reconciliation is unavailable");
    return reminderPreferenceView(user.reminderPreference, user.timezone);
  }

  async update(userId: string, input: ReminderPreferenceUpdateDto): Promise<ReminderPreferenceResponse> {
    assertTimezone(input.timezone);
    const quietStart = timeToMinute(input.quiet_hours.start);
    const quietEnd = timeToMinute(input.quiet_hours.end);
    if (quietStart === quietEnd) throw new BadRequestException("Quiet hours must have a nonzero duration");
    const advisorMinute = timeToMinute(input.advisor_time);
    const behaviorMinute = timeToMinute(input.behavior_time);
    const weeklyMinute = timeToMinute(input.weekly_report.time);
    if ([advisorMinute, behaviorMinute, weeklyMinute].some((minute) => isQuiet(minute, quietStart, quietEnd))) {
      throw new BadRequestException("Reminder target time cannot be inside quiet hours");
    }
    const requestHash = canonicalHash(input);

    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const [user, privacy] = await Promise.all([
        tx.user.findUnique({ where: { id: userId } }),
        tx.privacyReconciliation.findUnique({ where: { id: "global" } }),
      ]);
      if (!user || user.status !== "active") throw new ForbiddenException("User processing is unavailable");
      if (privacy?.status !== "ready") throw new ServiceUnavailableException("Privacy reconciliation is unavailable");
      const replay = await tx.reminderPreferenceMutation.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotency_key } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException("Idempotency key payload changed");
        return replay.resultJson as unknown as ReminderPreferenceResponse;
      }
      const current = await tx.reminderPreference.findUnique({ where: { userId } });
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expected_version) throw new ConflictException("Reminder preference version is stale");
      const nextTime = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() ?? 0) + 1));
      const data = {
        enabled: input.enabled,
        intensity: input.intensity,
        quietStartMinute: quietStart,
        quietEndMinute: quietEnd,
        advisorMinute,
        behaviorMinute,
        weeklyDay: weekdayNumber(input.weekly_report.day),
        weeklyMinute,
        updatedAt: nextTime,
      };
      const preference = current
        ? await tx.reminderPreference.update({ where: { userId }, data: { ...data, version: currentVersion + 1 } })
        : await tx.reminderPreference.create({ data: { userId, ...data, version: 1 } });
      if (user.timezone !== input.timezone) {
        await tx.user.update({ where: { id: userId }, data: { timezone: input.timezone } });
      }
      await tx.reminderPreferenceRevision.create({ data: {
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
      const result = reminderPreferenceView(preference, input.timezone);
      await tx.reminderPreferenceMutation.create({ data: {
        userId,
        idempotencyKey: input.idempotency_key,
        requestHash,
        resultJson: result as unknown as Prisma.InputJsonValue,
      } });
      return result;
    });
  }
}
