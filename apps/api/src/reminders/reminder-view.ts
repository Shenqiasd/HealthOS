import type { ReminderPreferenceResponse } from "@healthos/contracts";
import type { ReminderPreference } from "@prisma/client";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export function minuteToTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function timeToMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("Invalid reminder time");
  return hour! * 60 + minute!;
}

export function reminderPreferenceView(
  preference: ReminderPreference | null,
  timezone: string,
): ReminderPreferenceResponse {
  return preference ? {
    version: preference.version,
    enabled: preference.enabled,
    intensity: preference.intensity as ReminderPreferenceResponse["intensity"],
    timezone,
    quiet_hours: {
      start: minuteToTime(preference.quietStartMinute),
      end: minuteToTime(preference.quietEndMinute),
    },
    advisor_time: minuteToTime(preference.advisorMinute),
    behavior_time: minuteToTime(preference.behaviorMinute),
    weekly_report: {
      day: DAYS[preference.weeklyDay - 1]!,
      time: minuteToTime(preference.weeklyMinute),
    },
    updated_at: preference.updatedAt.toISOString(),
  } : {
    version: 0,
    enabled: false,
    intensity: "gentle",
    timezone,
    quiet_hours: { start: "22:00", end: "07:00" },
    advisor_time: "08:30",
    behavior_time: "18:30",
    weekly_report: { day: "monday", time: "09:00" },
    updated_at: null,
  };
}

export function weekdayNumber(day: string): number {
  const index = DAYS.indexOf(day as (typeof DAYS)[number]);
  if (index < 0) throw new Error("Invalid weekly report day");
  return index + 1;
}
