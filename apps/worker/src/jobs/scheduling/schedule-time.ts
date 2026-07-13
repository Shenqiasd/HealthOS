import { Temporal } from "@js-temporal/polyfill";

export interface LocalScheduleDecisionInput {
  now: Date;
  timezone: string;
  localMinute: number;
  cutoffMinutes: number;
}

export interface LocalScheduleDecision {
  state: "not_due" | "planned" | "missed_cutoff";
  localDate: string;
  scheduledAt: Date;
  cutoffAt: Date;
  resolvedLocalMinute: number;
  utcOffsetMinutes: number;
}

function instant(date: Date): Temporal.Instant {
  return Temporal.Instant.from(date.toISOString());
}

export function localScheduleDecision(input: LocalScheduleDecisionInput): LocalScheduleDecision {
  const current = instant(input.now);
  const localDate = current.toZonedDateTimeISO(input.timezone).toPlainDate();
  return localScheduleDecisionForDate({ ...input, localDate: localDate.toString() });
}

export function localScheduleDecisionForDate(
  input: LocalScheduleDecisionInput & { localDate: string },
): LocalScheduleDecision {
  const current = instant(input.now);
  const localDate = Temporal.PlainDate.from(input.localDate);
  const scheduled = Temporal.ZonedDateTime.from({
    timeZone: input.timezone,
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: Math.floor(input.localMinute / 60),
    minute: input.localMinute % 60,
  }, { disambiguation: "compatible" }).toInstant();
  const cutoff = scheduled.add({ minutes: input.cutoffMinutes });
  const comparison = Temporal.Instant.compare(current, scheduled);
  const state = comparison < 0
    ? "not_due"
    : Temporal.Instant.compare(current, cutoff) <= 0 ? "planned" : "missed_cutoff";
  return {
    state,
    localDate: localDate.toString(),
    scheduledAt: new Date(scheduled.toString()),
    cutoffAt: new Date(cutoff.toString()),
    resolvedLocalMinute: scheduled.toZonedDateTimeISO(input.timezone).hour * 60
      + scheduled.toZonedDateTimeISO(input.timezone).minute,
    utcOffsetMinutes: scheduled.toZonedDateTimeISO(input.timezone).offsetNanoseconds / 60_000_000_000,
  };
}

export function currentLocalWeekday(now: Date, timezone: string): number {
  return instant(now).toZonedDateTimeISO(timezone).dayOfWeek;
}

export function weeklyPeriodStart(localDate: string): string {
  const date = Temporal.PlainDate.from(localDate);
  return date.subtract({ days: date.dayOfWeek - 1 }).toString();
}

export function weekdayForLocalDate(localDate: string): number {
  return Temporal.PlainDate.from(localDate).dayOfWeek;
}

export function currentLocalDate(now: Date, timezone: string): string {
  return instant(now).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

export function boundedLocalDates(
  previousLocalDate: Date | null,
  now: Date,
  timezone: string,
  maximumDays: number,
  initialLocalDate?: string,
): string[] {
  const end = Temporal.PlainDate.from(currentLocalDate(now, timezone));
  const earliest = end.subtract({ days: maximumDays - 1 });
  const previous = previousLocalDate
    ? Temporal.PlainDate.from(previousLocalDate.toISOString().slice(0, 10))
    : Temporal.PlainDate.from(initialLocalDate ?? end.toString());
  let cursor = Temporal.PlainDate.compare(previous, earliest) < 0 ? earliest : previous;
  if (Temporal.PlainDate.compare(cursor, end) > 0) cursor = end;
  const dates: string[] = [];
  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    dates.push(cursor.toString());
    cursor = cursor.add({ days: 1 });
  }
  return dates;
}

export function localDateMinusDays(localDate: string, days: number): Date {
  return new Date(`${Temporal.PlainDate.from(localDate).subtract({ days }).toString()}T00:00:00.000Z`);
}

export function minuteIsQuiet(minute: number, quietStart: number, quietEnd: number): boolean {
  return quietStart < quietEnd
    ? minute >= quietStart && minute < quietEnd
    : minute >= quietStart || minute < quietEnd;
}

export function dateColumn(localDate: string): Date {
  return new Date(`${localDate}T00:00:00.000Z`);
}
