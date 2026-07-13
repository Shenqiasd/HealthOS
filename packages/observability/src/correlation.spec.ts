import { isValidCorrelationId, resolveCorrelationId } from "./correlation";

describe("resolveCorrelationId", () => {
  const generated = "00000000-0000-4000-8000-000000000001";

  test("preserves a valid incoming identifier", () => {
    const incoming = "00000000-0000-4000-8000-000000000002";
    expect(resolveCorrelationId(incoming, () => generated)).toBe(
      incoming,
    );
  });

  test("preserves only the fixed synthetic test identifier shape", () => {
    expect(resolveCorrelationId("healthos-test-0001", () => generated)).toBe("healthos-test-0001");
    expect(resolveCorrelationId("HEALTHOS-TEST-0001", () => generated)).toBe(generated);
    expect(resolveCorrelationId("healthos-test-ZhangSan-HbA1c-7.8", () => generated)).toBe(generated);
  });

  test.each([undefined, "short", "contains a space", "line\nbreak", "ZhangSan_HbA1c:7.8", "x".repeat(129)])(
    "generates a safe identifier for %p",
    (incoming) => {
      expect(resolveCorrelationId(incoming, () => generated)).toBe(generated);
    },
  );

  test("never returns an invalid generated identifier", () => {
    const correlationId = resolveCorrelationId(undefined, () => "bad");

    expect(correlationId).not.toBe("bad");
    expect(isValidCorrelationId(correlationId)).toBe(true);
  });

  test("rejects ambiguous duplicate correlation headers", () => {
    expect(
      resolveCorrelationId(
        ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"],
        () => generated,
      ),
    ).toBe(generated);
  });
});
