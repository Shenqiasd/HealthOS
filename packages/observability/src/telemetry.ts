import { resolveCorrelationId } from "./correlation";

export const TELEMETRY_SCHEMA_VERSION = "1.0" as const;
export const REDACTED_VALUE = "[REDACTED]" as const;
export const MAX_TELEMETRY_DEPTH = 6;
export const MAX_TELEMETRY_OBJECT_FIELDS = 32;
export const MAX_TELEMETRY_ARRAY_ITEMS = 20;
export const MAX_TELEMETRY_STRING_LENGTH = 128;
export const MAX_TELEMETRY_EVENT_BYTES = 8 * 1024;

const CIRCULAR_VALUE = "[CIRCULAR]" as const;
const MAX_DEPTH_VALUE = "[MAX_DEPTH]" as const;
const TRUNCATED_VALUE = "[TRUNCATED]" as const;

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SECRET_VALUE_PATTERNS = [
  /^(?:bearer|basic)\s/i,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  /^(?:sk|pk|api|token|secret)[-_][A-Za-z0-9_-]{8,}$/i,
  /^[^=\s]+=[^;]+/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
];

const SAFE_STRING_VALUES = new Map<string, ReadonlySet<string>>([
  ["channel", new Set(["apns", "wecom", "in_app"])],
  ["channel_type", new Set(["apns", "wecom", "in_app"])],
  ["component", new Set(["api", "worker", "recommendation-worker", "respectful-scheduler"])],
  ["http_method", new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])],
  ["outcome", new Set(["blocked", "fixed_fallback", "auto_publish", "review_required"])],
  ["reason_code", new Set([
    "control_epoch_missing", "missing_request", "user_inactive", "privacy_not_ready", "consent_invalid",
    "profile_superseded", "rule_bundle_invalid", "feature_daily_recommendations_disabled",
    "kill_switch_global", "kill_switch_user", "kill_switch_rule_bundle", "failed_users",
  ])],
  ["state", new Set(["pending", "active", "completed", "failed", "suppressed"])],
  ["status", new Set(["pending", "active", "complete", "completed", "failed", "retrying", "partial", "suppressed"])],
]);

const SAFE_NUMBER_KEYS = new Set([
  "attempt",
  "batch_size",
  "count",
  "duration_ms",
  "http_status",
  "lag_ms",
  "queue_depth",
  "retry_count",
  "revision",
]);

const SAFE_BOOLEAN_KEYS = new Set([
  "cached",
  "degraded",
  "retryable",
  "success",
]);

const SAFE_CONTAINER_KEYS = new Set([
  "context",
  "details",
  "dimensions",
  "items",
  "metadata",
]);

const SENSITIVE_KEY_FRAGMENTS = [
  "accountid",
  "address",
  "authorization",
  "bloodpressure",
  "channelid",
  "channelidentifier",
  "cholesterol",
  "content",
  "cookie",
  "credential",
  "deviceid",
  "diagnosis",
  "email",
  "evidence",
  "exception",
  "externalid",
  "glucose",
  "hba1c",
  "health",
  "heartrate",
  "lab",
  "medication",
  "message",
  "note",
  "password",
  "phone",
  "prompt",
  "providerid",
  "raw",
  "referencerange",
  "response",
  "result",
  "session",
  "stack",
  "summary",
  "symptom",
  "tenantid",
  "token",
  "userid",
  "value",
  "weight",
];

export type TelemetrySeverity = "debug" | "info" | "warn" | "error" | "fatal";

export type TelemetryValue =
  | null
  | boolean
  | number
  | string
  | TelemetryValue[]
  | { [key: string]: TelemetryValue };

export type TelemetryAttributes = Record<string, TelemetryValue>;

export interface TelemetryEvent {
  readonly schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  readonly event_name: string;
  readonly severity: TelemetrySeverity;
  readonly timestamp: string;
  readonly correlation_id: string;
  readonly attributes: TelemetryAttributes;
}

export interface CreateTelemetryEventInput {
  readonly eventName: string;
  readonly severity: TelemetrySeverity;
  readonly correlationId?: string | string[];
  readonly attributes?: unknown;
}

export interface CreateTelemetryEventOptions {
  readonly now?: () => Date;
  readonly generateCorrelationId?: () => string;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "text") return true;
  if (normalized.endsWith("id") && normalized !== "correlationid") return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isSafeCode(key: string, value: string): boolean {
  return value.length <= MAX_TELEMETRY_STRING_LENGTH &&
    SAFE_STRING_VALUES.get(key)?.has(value) === true &&
    !SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeArray(
  value: readonly unknown[],
  depth: number,
  ancestors: Set<object>,
): TelemetryValue[] {
  const sanitized = value
    .slice(0, MAX_TELEMETRY_ARRAY_ITEMS)
    .map((item) => sanitizeContainerValue(item, depth + 1, ancestors));
  if (value.length > MAX_TELEMETRY_ARRAY_ITEMS) sanitized.push(TRUNCATED_VALUE);
  return sanitized;
}

function sanitizeObject(
  value: object,
  depth: number,
  ancestors: Set<object>,
): TelemetryAttributes {
  if (ancestors.has(value)) return { telemetry_cycle: CIRCULAR_VALUE };
  if (depth >= MAX_TELEMETRY_DEPTH) return { telemetry_depth: MAX_DEPTH_VALUE };
  if (value instanceof Error) {
    return { telemetry_redacted_fields: 1, telemetry_redaction: REDACTED_VALUE };
  }

  ancestors.add(value);
  try {
    let keys: string[];
    try {
      keys = Object.keys(value).sort();
    } catch {
      return { telemetry_redacted_fields: 1, telemetry_redaction: REDACTED_VALUE };
    }

    const output: Array<[string, TelemetryValue]> = [];
    let redactedFields = 0;
    const boundedKeys = keys.slice(0, MAX_TELEMETRY_OBJECT_FIELDS);

    for (const key of boundedKeys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        redactedFields += 1;
        continue;
      }

      if (!descriptor || !("value" in descriptor)) {
        redactedFields += 1;
        continue;
      }

      if (isSensitiveKey(key)) {
        redactedFields += 1;
        continue;
      }

      const propertyValue = descriptor.value as unknown;
      if (SAFE_CONTAINER_KEYS.has(key)) {
        output.push([key, sanitizeContainerValue(propertyValue, depth + 1, ancestors)]);
        continue;
      }
      if (SAFE_STRING_VALUES.has(key) && typeof propertyValue === "string") {
        if (isSafeCode(key, propertyValue)) output.push([key, propertyValue]);
        else redactedFields += 1;
        continue;
      }
      if (
        SAFE_NUMBER_KEYS.has(key) &&
        typeof propertyValue === "number" &&
        Number.isFinite(propertyValue)
      ) {
        output.push([key, propertyValue]);
        continue;
      }
      if (SAFE_BOOLEAN_KEYS.has(key) && typeof propertyValue === "boolean") {
        output.push([key, propertyValue]);
        continue;
      }
      redactedFields += 1;
    }

    redactedFields += Math.max(0, keys.length - boundedKeys.length);
    if (redactedFields > 0) {
      output.push(["telemetry_redacted_fields", redactedFields]);
      output.push(["telemetry_redaction", REDACTED_VALUE]);
    }
    if (keys.length > MAX_TELEMETRY_OBJECT_FIELDS) {
      output.push(["telemetry_truncated", true]);
    }
    return Object.fromEntries(
      output.sort(([left], [right]) => left.localeCompare(right)),
    );
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeContainerValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): TelemetryValue {
  if (depth >= MAX_TELEMETRY_DEPTH) return MAX_DEPTH_VALUE;
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR_VALUE;
    ancestors.add(value);
    try {
      return sanitizeArray(value, depth, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") return sanitizeObject(value, depth, ancestors);
  return REDACTED_VALUE;
}

export function sanitizeTelemetryAttributes(input: unknown): TelemetryAttributes {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { telemetry_redacted_fields: 1, telemetry_redaction: REDACTED_VALUE };
  }
  return sanitizeObject(input, 0, new Set<object>());
}

function assertEventName(eventName: string): void {
  if (
    eventName.length === 0 ||
    eventName.length > 96 ||
    !EVENT_NAME_PATTERN.test(eventName)
  ) {
    throw new TypeError(
      "eventName must be a lowercase dotted telemetry name of at most 96 characters",
    );
  }
}

function assertSeverity(severity: string): asserts severity is TelemetrySeverity {
  if (
    !(
      severity === "debug" ||
      severity === "info" ||
      severity === "warn" ||
      severity === "error" ||
      severity === "fatal"
    )
  ) {
    throw new TypeError("severity must be debug, info, warn, error, or fatal");
  }
}

export function createTelemetryEvent(
  input: CreateTelemetryEventInput,
  options: CreateTelemetryEventOptions = {},
): TelemetryEvent {
  assertEventName(input.eventName);
  assertSeverity(input.severity);

  const timestamp = (options.now ?? (() => new Date()))();
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("timestamp must be a valid Date");
  }

  const event: TelemetryEvent = {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    event_name: input.eventName,
    severity: input.severity,
    timestamp: timestamp.toISOString(),
    correlation_id: resolveCorrelationId(
      input.correlationId,
      options.generateCorrelationId,
    ),
    attributes: sanitizeTelemetryAttributes(input.attributes ?? {}),
  };

  if (Buffer.byteLength(JSON.stringify(event), "utf8") <= MAX_TELEMETRY_EVENT_BYTES) {
    return deepFreeze(event);
  }
  return deepFreeze({
    ...event,
    attributes: { telemetry_truncated: true },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly #capacity: number;
  readonly #events: TelemetryEvent[] = [];

  constructor(capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new RangeError("capacity must be an integer between 1 and 10000");
    }
    this.#capacity = capacity;
  }

  get events(): readonly TelemetryEvent[] {
    return [...this.#events];
  }

  emit(event: TelemetryEvent): void {
    const snapshot = deepFreeze(
      JSON.parse(JSON.stringify(event)) as TelemetryEvent,
    );
    this.#events.push(snapshot);
    if (this.#events.length > this.#capacity) this.#events.shift();
  }

  clear(): void {
    this.#events.length = 0;
  }
}
