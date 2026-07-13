import {
  MAX_TELEMETRY_ARRAY_ITEMS,
  MAX_TELEMETRY_EVENT_BYTES,
  REDACTED_VALUE,
  TELEMETRY_SCHEMA_VERSION,
  InMemoryTelemetrySink,
  createTelemetryEvent,
  sanitizeTelemetryAttributes,
} from "./telemetry";

describe("telemetry privacy contract", () => {
  test("deeply redacts health, lab, credential, identifier, and exception data", () => {
    const attributes = sanitizeTelemetryAttributes({
      component: "recommendation-worker",
      status: "failed",
      duration_ms: 42,
      context: {
        health_text: "Patient reports chest pain",
        lab_value: 7.8,
        normalizedValue: 7.8,
        access_token: "secret-access-token",
        authorization: "Bearer secret-bearer-token",
        cookies: ["session=secret-cookie"],
        external_id: "wx-open-id-secret",
        channelIdentifier: "channel-user-secret",
        user_id: "user-secret",
        nested: [
          {
            exception: new Error("raw database exception with patient name"),
            message: "raw exception message",
            glucose: 9.1,
          },
        ],
      },
    });

    const serialized = JSON.stringify(attributes);
    for (const secret of [
      "chest pain",
      "7.8",
      "secret-access-token",
      "secret-bearer-token",
      "secret-cookie",
      "wx-open-id-secret",
      "channel-user-secret",
      "user-secret",
      "raw database exception",
      "raw exception message",
      "9.1",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(attributes).toMatchObject({
      component: "recommendation-worker",
      status: "failed",
      duration_ms: 42,
      context: expect.any(Object),
    });
    expect(serialized).toContain(REDACTED_VALUE);
  });

  test("handles circular, throwing-accessor, Unicode, and opaque long inputs", () => {
    const circular: Record<string, unknown> = { status: "retrying" };
    circular.context = circular;
    Object.defineProperty(circular, "message", {
      enumerable: true,
      get() {
        throw new Error("getter secret must never be evaluated");
      },
    });

    const attributes = sanitizeTelemetryAttributes({
      component: "api",
      operation: "推荐失败：张三血糖偏高",
      status: "x".repeat(10_000),
      context: circular,
    });
    const serialized = JSON.stringify(attributes);

    expect(serialized).not.toContain("张三");
    expect(serialized).not.toContain("血糖");
    expect(serialized).not.toContain("getter secret");
    expect(serialized).not.toContain("x".repeat(100));
    expect(serialized).toContain(REDACTED_VALUE);
    expect(serialized).toContain("[CIRCULAR]");
  });

  test("bounds depth, object fields, arrays, strings, and total event size", () => {
    let nested: Record<string, unknown> = { status: "complete" };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { context: nested };
    }

    const event = createTelemetryEvent({
      eventName: "recommendation.completed",
      severity: "info",
      correlationId: "00000000-0000-4000-8000-000000000011",
      attributes: {
        context: nested,
        items: Array.from({ length: 100 }, (_, index) => ({ attempt: index })),
        metadata: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`unknown_${index}`, "private value"]),
        ),
      },
    });

    expect((event.attributes.items as unknown[]).length).toBeLessThanOrEqual(
      MAX_TELEMETRY_ARRAY_ITEMS + 1,
    );
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
      MAX_TELEMETRY_EVENT_BYTES,
    );
    expect(JSON.stringify(event)).not.toContain("private value");
  });
});

describe("telemetry event and sink contract", () => {
  const now = new Date("2026-07-13T08:09:10.123Z");

  test("creates the stable event schema and preserves one valid correlation ID", () => {
    const event = createTelemetryEvent(
      {
        eventName: "worker.job.completed",
        severity: "info",
        correlationId: "00000000-0000-4000-8000-000000000011",
        attributes: { component: "worker", status: "complete", duration_ms: 25 },
      },
      { now: () => now },
    );

    expect(event).toEqual({
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_name: "worker.job.completed",
      severity: "info",
      timestamp: "2026-07-13T08:09:10.123Z",
      correlation_id: "00000000-0000-4000-8000-000000000011",
      attributes: { component: "worker", duration_ms: 25, status: "complete" },
    });
    expect(() => {
      (event.attributes as Record<string, unknown>).health_text = "late PHI";
    }).toThrow();
  });

  test("drops identifier and health-value payloads disguised as codes or correlation IDs", () => {
    const event = createTelemetryEvent(
      {
        eventName: "recommendation.suppressed",
        severity: "warn",
        correlationId: "ZhangSan_HbA1c:7.8",
        attributes: {
          component: "recommendation-worker",
          status: "ZhangSan_HbA1c:7.8",
          reason_code: "00000000-0000-4000-8000-000000000099",
          context: { status: "glucose_9.8", reason_code: "patient_zhangsan" },
        },
      },
      { generateCorrelationId: () => "00000000-0000-4000-8000-000000000012" },
    );
    const serialized = JSON.stringify(event);
    expect(event.correlation_id).toBe("00000000-0000-4000-8000-000000000012");
    for (const sensitive of ["ZhangSan", "HbA1c", "7.8", "00000000-0000-4000-8000-000000000099", "glucose_9.8", "patient_zhangsan"]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  test.each(["", "Worker Job", "a".repeat(97)])(
    "rejects invalid event name %p",
    (eventName) => {
      expect(() =>
        createTelemetryEvent({ eventName, severity: "info", attributes: {} }),
      ).toThrow("eventName");
    },
  );

  test("stores bounded local snapshots without any external transport", () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const sink = new InMemoryTelemetrySink(2);
    const first = createTelemetryEvent(
      { eventName: "worker.started", severity: "debug", attributes: {} },
      { now: () => now, generateCorrelationId: () => "00000000-0000-4000-8000-000000000031" },
    );
    const second = createTelemetryEvent(
      { eventName: "worker.completed", severity: "info", attributes: {} },
      { now: () => now, generateCorrelationId: () => "00000000-0000-4000-8000-000000000032" },
    );
    const third = createTelemetryEvent(
      { eventName: "worker.failed", severity: "error", attributes: {} },
      { now: () => now, generateCorrelationId: () => "00000000-0000-4000-8000-000000000033" },
    );

    sink.emit(first);
    sink.emit(second);
    sink.emit(third);

    expect(sink.events.map((event) => event.event_name)).toEqual([
      "worker.completed",
      "worker.failed",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => {
      (sink.events[0] as { event_name: string }).event_name = "tampered";
    }).toThrow();
    sink.clear();
    expect(sink.events).toEqual([]);
    fetchSpy.mockRestore();
  });
});
