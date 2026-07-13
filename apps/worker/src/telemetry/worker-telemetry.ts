import {
  InMemoryTelemetrySink,
  createTelemetryEvent,
  type TelemetryEvent,
  type TelemetrySeverity,
  type TelemetrySink,
} from "@healthos/observability";

export class WorkerTelemetry {
  constructor(private readonly sink: TelemetrySink = new InMemoryTelemetrySink(500)) {}

  async record(input: {
    eventName: string;
    severity: TelemetrySeverity;
    correlationId?: string;
    attributes: unknown;
  }): Promise<TelemetryEvent> {
    const event = createTelemetryEvent({
      eventName: input.eventName,
      severity: input.severity,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      attributes: input.attributes,
    });
    try {
      await this.sink.emit(event);
    } catch {
      // Telemetry must never change a health workflow decision.
    }
    return event;
  }
}
