import { resolveCorrelationId } from "./correlation";

describe("resolveCorrelationId", () => {
  const generated = "00000000-0000-4000-8000-000000000000";

  test("preserves a valid incoming identifier", () => {
    expect(resolveCorrelationId("healthos-request-0001", () => generated)).toBe(
      "healthos-request-0001",
    );
  });

  test.each([undefined, "short", "contains a space", "line\nbreak", "x".repeat(129)])(
    "generates a safe identifier for %p",
    (incoming) => {
      expect(resolveCorrelationId(incoming, () => generated)).toBe(generated);
    },
  );
});
