import { randomUUID } from "node:crypto";

export const CORRELATION_ID_HEADER = "x-correlation-id";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function resolveCorrelationId(
  incoming: string | string[] | undefined,
  generate: () => string = randomUUID,
): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  if (candidate && CORRELATION_ID_PATTERN.test(candidate)) return candidate;
  return generate();
}
