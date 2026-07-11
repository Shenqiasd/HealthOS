import type { AdminReviewTaskPage, AdminSafetyIncidentPage } from "@healthos/contracts";
import type { AdminWebSession } from "./admin-web-session";

export type ReviewQueueState =
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "empty" }
  | ({ kind: "ready" } & AdminReviewTaskPage);

export type SafetyQueueState =
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "empty" }
  | ({ kind: "ready" } & AdminSafetyIncidentPage);

interface OperationsApiConfig {
  baseUrl?: string;
  accessToken?: string;
  fetcher?: typeof fetch;
}

async function load<T extends { items: unknown[]; next_cursor: string | null }>(
  path: string,
  config: OperationsApiConfig,
): Promise<{ kind: "unavailable" } | { kind: "error" } | { kind: "empty" } | ({ kind: "ready" } & T)> {
  if (!config.baseUrl || !config.accessToken) return { kind: "unavailable" };
  try {
    const response = await (config.fetcher ?? fetch)(new URL(path, config.baseUrl), {
      cache: "no-store",
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!response.ok) return { kind: "error" };
    const body = await response.json() as T;
    if (!Array.isArray(body.items) || !(typeof body.next_cursor === "string" || body.next_cursor === null)) {
      return { kind: "error" };
    }
    return body.items.length === 0 ? { kind: "empty" } : { kind: "ready", ...body };
  } catch {
    return { kind: "error" };
  }
}

export function loadReviewQueue(config: OperationsApiConfig): Promise<ReviewQueueState> {
  return load<AdminReviewTaskPage>("/admin/review-tasks?limit=50", config);
}

export function loadSafetyQueue(config: OperationsApiConfig): Promise<SafetyQueueState> {
  return load<AdminSafetyIncidentPage>("/admin/safety-incidents?limit=50", config);
}

export function serverOperationsConfig(session: AdminWebSession): OperationsApiConfig {
  return {
    baseUrl: process.env.HEALTHOS_API_BASE_URL,
    accessToken: session.accessToken,
  };
}
