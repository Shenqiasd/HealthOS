import type { INestApplication } from "@nestjs/common";

import { createApp } from "../src/main";

describe("health endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test("liveness returns the minimal contract and a generated correlation ID", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a valid incoming correlation ID is echoed", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-correlation-id": "healthos-test-0001" },
    });

    expect(response.headers["x-correlation-id"]).toBe("healthos-test-0001");
  });

  test("an invalid incoming correlation ID is replaced", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-correlation-id": "contains a space" },
    });

    expect(response.headers["x-correlation-id"]).not.toBe("contains a space");
    expect(response.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("readiness fails closed and reports each unconfigured dependency", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      dependencies: {
        database: { status: "not_configured" },
        object_storage: { status: "not_configured" },
        worker_lease: { status: "not_configured" },
      },
    });
  });

  test("unknown routes use a stable redacted error envelope", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { "x-correlation-id": "healthos-test-0002" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not Found",
        correlation_id: "healthos-test-0002",
      },
    });
  });
});
