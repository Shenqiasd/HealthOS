import { randomUUID } from "node:crypto";

export const CORRELATION_ID_HEADER = "x-correlation-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNTHETIC_CORRELATION_ID_PATTERN = /^healthos-test-[0-9]{4}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (UUID_PATTERN.test(value) || SYNTHETIC_CORRELATION_ID_PATTERN.test(value))
  );
}

export function resolveCorrelationId(
  incoming: string | string[] | undefined,
  generate: () => string = randomUUID,
): string {
  const candidate = Array.isArray(incoming)
    ? incoming.length === 1
      ? incoming[0]
      : undefined
    : incoming;
  if (isValidCorrelationId(candidate)) return candidate;

  try {
    const generated = generate();
    if (isValidCorrelationId(generated)) return generated;
  } catch {
    // Fall through to the platform generator so callers never receive invalid input.
  }

  return randomUUID();
}
