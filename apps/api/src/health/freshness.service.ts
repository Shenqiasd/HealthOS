import type { DatabaseService } from "../database/prisma.service";

interface CurrentFactRow {
  local_date: Date;
  coverage: string | null;
}

export class FreshnessService {
  constructor(private readonly database: DatabaseService) {}

  async forUser(userId: string, now: Date) {
    const latestRun = await this.database.healthSyncRun.findFirst({
      where: { userId, status: "completed" },
      orderBy: { serverSequence: "desc" },
      select: { timezone: true },
    });
    const rows = await this.database.$queryRaw<CurrentFactRow[]>`
      SELECT "local_date", "coverage"
      FROM "current_daily_health_facts"
      WHERE "user_id" = ${userId}::uuid
      ORDER BY "local_date" DESC
    `;
    if (rows.length === 0) return { status: "absent" as const, latestLocalDate: null };
    const latest = rows[0]!.local_date;
    const latestIso = latest.toISOString().slice(0, 10);
    const timezone = latestRun?.timezone ?? "UTC";
    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const year = Number(dateParts.find((part) => part.type === "year")?.value);
    const month = Number(dateParts.find((part) => part.type === "month")?.value);
    const day = Number(dateParts.find((part) => part.type === "day")?.value);
    const nowDay = Date.UTC(year, month - 1, day);
    const latestDay = Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate());
    const ageDays = Math.floor((nowDay - latestDay) / 86_400_000);
    if (ageDays > 2) return { status: "stale" as const, latestLocalDate: latestIso };
    const latestRows = rows.filter((row) => row.local_date.getTime() === latest.getTime());
    const partial = latestRows.some((row) => row.coverage === null || Number(row.coverage) < 0.8);
    return {
      status: partial ? "partial" as const : "current" as const,
      latestLocalDate: latestIso,
    };
  }
}
