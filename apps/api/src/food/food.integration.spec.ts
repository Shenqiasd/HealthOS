import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";

import { AppModule } from "../app.module";
import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";

const SYNTHETIC_SHA = "f".repeat(64);

describe("authenticated Food Risk Scan API", () => {
  const database = new DatabaseService();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.food.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-food-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-food-subject-hash-key-32-characters";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.HEALTHOS_FOOD_MODE = "synthetic";
    process.env.HEALTHOS_FOOD_FIXTURE_DIR = resolve(__dirname, "../../../../packages/test-fixtures/food");
    await database.$connect();
    const module_ = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module_.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  beforeEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions,
        safety_control_mutations, safety_control_audit_consumptions
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  async function authorizedUser() {
    const user = await database.user.create({ data: { consentEpoch: 1 } });
    await database.consentRecord.create({ data: {
      userId: user.id,
      consentType: "health_processing",
      documentVersion: "synthetic-food-v1",
      granted: true,
      epoch: 1,
      correlationId: randomUUID(),
      requestHash: randomUUID(),
      source: "synthetic",
    } });
    const tokens = await app.get(SessionService).issue(user.id);
    return { user, headers: { authorization: `Bearer ${tokens.accessToken}` } };
  }

  function intake(headers: Record<string, string>, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/food/scans",
      headers: { ...headers, "x-correlation-id": randomUUID() },
      payload: {
        idempotency_key: randomUUID(),
        sha256: SYNTHETIC_SHA,
        mime_type: "image/jpeg",
        size_bytes: 2048,
        captured_at: "2026-07-14T04:00:00.000Z",
        ...overrides,
      },
    });
  }

  test("creates, replays, finalizes, and hides one bounded owned synthetic scan", async () => {
    const owner = await authorizedUser();
    const key = randomUUID();
    const first = await intake(owner.headers, { idempotency_key: key });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      sha256: SYNTHETIC_SHA,
      mime_type: "image/jpeg",
      size_bytes: 2048,
      status: "pending",
      dish_candidates: [],
      risk_labels: [],
      latest_correction: null,
    });
    expect(JSON.stringify(first.json())).not.toMatch(/kcal|calorie|protein|carbs|fat|macro|diagnos|retrain/i);

    const replay = await intake(owner.headers, { idempotency_key: key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    const changed = await intake(owner.headers, { idempotency_key: key, size_bytes: 2049 });
    expect(changed.statusCode).toBe(409);

    const finalized = await app.inject({
      method: "POST",
      url: `/food/scans/${first.json().id}/finalize`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID() },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().status).toBe("active");
    expect(await database.domainOutbox.count({ where: { eventType: "food.scan.ready" } })).toBe(1);

    const stranger = await authorizedUser();
    const hidden = await app.inject({
      method: "GET",
      url: `/food/scans/${first.json().id}`,
      headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
  });

  test("rejects invalid image bounds, forbidden precision fields, and object mismatches", async () => {
    const owner = await authorizedUser();
    for (const payload of [
      { mime_type: "image/gif" },
      { size_bytes: 10 * 1024 * 1024 + 1 },
      { sha256: "not-a-digest" },
      { kcal: 800 },
      { protein: 20 },
    ]) {
      expect((await intake(owner.headers, payload)).statusCode).toBe(400);
    }

    const mismatched = await intake(owner.headers, { size_bytes: 2049 });
    expect(mismatched.statusCode).toBe(201);
    const finalized = await app.inject({
      method: "POST",
      url: `/food/scans/${mismatched.json().id}/finalize`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID() },
    });
    expect(finalized.statusCode).toBe(409);
    expect(await database.domainOutbox.count({ where: { eventType: "food.scan.ready" } })).toBe(0);
  });

  test("appends idempotent immutable corrections without publishing trusted health inputs", async () => {
    const owner = await authorizedUser();
    const scan = await database.foodScan.create({ data: {
      userId: owner.user.id,
      objectKey: `synthetic-food/${randomUUID()}`,
      capturedAt: new Date("2026-07-14T04:00:00.000Z"),
      modelVersion: "synthetic-food-v1",
      overallConfidence: 0.6,
      consentEpoch: 1,
      status: "completed",
    } });
    const correction = {
      idempotency_key: randomUUID(),
      expected_version: 1,
      meal_presence: "food",
      meal_completeness: "cropped",
      dish_codes: ["white_rice", "milk_tea"],
      labels: [{ label: "sugary_drink", level: "high" }],
      reason: "synthetic_user_correction",
    };
    const first = await app.inject({
      method: "POST",
      url: `/food/scans/${scan.id}/corrections`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: correction,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 2, disposition_code: "user_confirmed" });
    expect(first.json().latest_correction).toMatchObject({
      meal_presence: "food",
      meal_completeness: "cropped",
      dish_codes: ["white_rice", "milk_tea"],
      labels: [{ label: "sugary_drink", level: "high" }],
    });
    expect(JSON.stringify(first.json())).not.toMatch(/kcal|calorie|protein|carbs|fat|macro|diagnos|retrain/i);

    const replay = await app.inject({
      method: "POST",
      url: `/food/scans/${scan.id}/corrections`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: correction,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const rows = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "food_correction_events" WHERE "food_scan_id" = ${scan.id}::uuid
    `;
    expect(Number(rows[0]?.count)).toBe(1);
    expect(await database.profileEvent.count({ where: { userId: owner.user.id } })).toBe(0);
    expect(await database.recommendationRun.count({ where: { userId: owner.user.id } })).toBe(0);

    const reused = await app.inject({
      method: "POST",
      url: `/food/scans/${scan.id}/corrections`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { ...correction, meal_completeness: "complete" },
    });
    expect(reused.statusCode).toBe(409);
    const forbidden = await app.inject({
      method: "POST",
      url: `/food/scans/${scan.id}/corrections`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { ...correction, idempotency_key: randomUUID(), expected_version: 2, calories: 500 },
    });
    expect(forbidden.statusCode).toBe(400);
    for (const labels of [
      [null],
      ["sugary_drink"],
      [{ label: "sugary_drink", level: "high", score: 1 }],
    ]) {
      const malformed = await app.inject({
        method: "POST",
        url: `/food/scans/${scan.id}/corrections`,
        headers: { ...owner.headers, "x-correlation-id": randomUUID() },
        payload: {
          ...correction,
          idempotency_key: randomUUID(),
          expected_version: 2,
          labels,
        },
      });
      expect(malformed.statusCode).toBe(400);
    }
  });

  test("linearizes concurrent corrections into one event and one explicit conflict", async () => {
    const owner = await authorizedUser();
    const scan = await database.foodScan.create({ data: {
      userId: owner.user.id,
      objectKey: `synthetic-food/${randomUUID()}`,
      capturedAt: new Date("2026-07-14T04:00:00.000Z"),
      modelVersion: "synthetic-food-v1",
      overallConfidence: 0.7,
      consentEpoch: 1,
      status: "completed",
    } });
    const attempts = await Promise.all([0, 1].map(() => app.inject({
      method: "POST",
      url: `/food/scans/${scan.id}/corrections`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: {
        idempotency_key: randomUUID(),
        expected_version: 1,
        meal_presence: "food",
        meal_completeness: "complete",
        dish_codes: ["white_rice"],
        labels: [{ label: "refined_carbohydrate", level: "medium" }],
        reason: "synthetic_concurrent_correction",
      },
    })));
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await database.foodCorrectionEvent.count({ where: { foodScanId: scan.id } })).toBe(1);
    expect((await database.foodScan.findUniqueOrThrow({ where: { id: scan.id } })).version).toBe(2);
  });

  test("suppresses correction after consent withdrawal or deletion and does not leak ownership", async () => {
    for (const boundary of ["consent", "deletion"] as const) {
      const owner = await authorizedUser();
      const scan = await database.foodScan.create({ data: {
        userId: owner.user.id,
        objectKey: `synthetic-food/${randomUUID()}`,
        capturedAt: new Date(),
        modelVersion: "synthetic-food-v1",
        overallConfidence: 0.5,
        consentEpoch: 1,
        status: "completed",
      } });
      if (boundary === "consent") {
        await database.user.update({ where: { id: owner.user.id }, data: { consentEpoch: 2 } });
        await database.consentRecord.create({ data: {
          userId: owner.user.id,
          consentType: "health_processing",
          documentVersion: "synthetic-food-v2",
          granted: false,
          epoch: 2,
          correlationId: randomUUID(),
          requestHash: randomUUID(),
          source: "synthetic",
        } });
      } else {
        await database.user.update({ where: { id: owner.user.id }, data: { status: "deleting", deletedAt: new Date() } });
      }
      const response = await app.inject({
        method: "POST",
        url: `/food/scans/${scan.id}/corrections`,
        headers: { ...owner.headers, "x-correlation-id": randomUUID() },
        payload: {
          idempotency_key: randomUUID(),
          expected_version: 1,
          meal_presence: "uncertain",
          meal_completeness: "unknown",
          dish_codes: [],
          labels: [],
          reason: "synthetic_boundary_test",
        },
      });
      expect(response.statusCode).toBe(boundary === "deletion" ? 401 : 403);
      await database.$executeRawUnsafe(`
        TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions,
          safety_control_mutations, safety_control_audit_consumptions
        RESTART IDENTITY CASCADE
      `);
      await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
    }
  });
});
