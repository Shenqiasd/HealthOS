import { randomBytes, randomUUID } from "node:crypto";

import { ValidationPipe } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";

import { AdminIdentityVerifier, type VerifiedAdminIdentity } from "../admin/admin-identity.verifier";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/prisma.service";
import { SessionService } from "../identity/session.service";
import { LabObjectStore, type LabObjectMetadata } from "./lab-object-store";

class SyntheticObjectStore extends LabObjectStore {
  readonly objects = new Map<string, LabObjectMetadata>();

  async head(objectKey: string): Promise<LabObjectMetadata> {
    const metadata = this.objects.get(objectKey);
    if (!metadata) throw new Error("Synthetic object is missing");
    return metadata;
  }
}

class SyntheticAdminVerifier extends AdminIdentityVerifier {
  readonly tokens = new Map<string, VerifiedAdminIdentity>();
  async verify(token: string): Promise<VerifiedAdminIdentity> {
    const identity = this.tokens.get(token);
    if (!identity) throw new Error("Synthetic administrator is unknown");
    return identity;
  }
}

describe("authenticated Labs API", () => {
  const database = new DatabaseService();
  const objects = new SyntheticObjectStore();
  const adminVerifier = new SyntheticAdminVerifier();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = "synthetic.labs.client";
    process.env.SESSION_SIGNING_SECRET = "synthetic-labs-session-secret-32-characters";
    process.env.APPLE_SUBJECT_HASH_KEY = "synthetic-labs-subject-hash-key-32-characters";
    process.env.DEVICE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.HEALTHOS_LABS_MODE = "synthetic";
    await database.$connect();
    const module_ = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LabObjectStore).useValue(objects)
      .overrideProvider(AdminIdentityVerifier).useValue(adminVerifier)
      .compile();
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
    objects.objects.clear();
    adminVerifier.tokens.clear();
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
      userId: user.id, consentType: "health_processing", documentVersion: "synthetic-labs-v1",
      granted: true, epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
    } });
    const tokens = await app.get(SessionService).issue(user.id);
    return { user, headers: { authorization: `Bearer ${tokens.accessToken}` } };
  }

  function intake(headers: Record<string, string>, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST", url: "/labs/documents", headers: { ...headers, "x-correlation-id": randomUUID() },
      payload: {
        idempotency_key: randomUUID(), sha256: "a".repeat(64), mime_type: "application/pdf",
        size_bytes: 4096, ...overrides,
      },
    });
  }

  test("creates and finalizes one owned document with verified object metadata and exact replay", async () => {
    const owner = await authorizedUser();
    const idempotencyKey = randomUUID();
    const first = await intake(owner.headers, { idempotency_key: idempotencyKey });
    expect(first.statusCode).toBe(201);
    const document = first.json();
    expect(document).toMatchObject({ status: "pending", mime_type: "application/pdf", size_bytes: 4096 });
    const replayedIntake = await intake(owner.headers, { idempotency_key: idempotencyKey });
    expect(replayedIntake.statusCode).toBe(201);
    expect(replayedIntake.json().id).toBe(document.id);
    const changedReplay = await intake(owner.headers, { idempotency_key: idempotencyKey, size_bytes: 4097 });
    expect(changedReplay.statusCode).toBe(409);
    const deduplicated = await intake(owner.headers);
    expect(deduplicated.json().id).toBe(document.id);
    objects.objects.set(document.object_key, {
      sha256: "a".repeat(64), mimeType: "application/pdf", sizeBytes: 4096,
    });

    const finalized = await app.inject({
      method: "POST", url: `/labs/documents/${document.id}/finalize`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID() },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().status).toBe("active");
    const replay = await app.inject({
      method: "POST", url: `/labs/documents/${document.id}/finalize`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID() },
    });
    expect(replay.statusCode).toBe(200);
    expect(await database.domainOutbox.count({ where: { eventType: "lab.document.ready" } })).toBe(1);

    const stranger = await authorizedUser();
    const hidden = await app.inject({
      method: "GET", url: `/labs/documents/${document.id}`, headers: stranger.headers,
    });
    expect(hidden.statusCode).toBe(404);
  });

  test("rejects invalid upload bounds and every object-head mismatch without enqueueing", async () => {
    const owner = await authorizedUser();
    for (const payload of [
      { mime_type: "text/html" },
      { size_bytes: 20 * 1024 * 1024 + 1 },
      { sha256: "not-a-digest" },
    ]) {
      const response = await intake(owner.headers, payload);
      expect(response.statusCode).toBe(400);
    }

    for (const mismatch of [
      { sha256: "b".repeat(64), mimeType: "application/pdf", sizeBytes: 4096 },
      { sha256: "a".repeat(64), mimeType: "image/png", sizeBytes: 4096 },
      { sha256: "a".repeat(64), mimeType: "application/pdf", sizeBytes: 4095 },
    ] satisfies LabObjectMetadata[]) {
      const created = (await intake(owner.headers)).json();
      objects.objects.set(created.object_key, mismatch);
      const response = await app.inject({
        method: "POST", url: `/labs/documents/${created.id}/finalize`,
        headers: { ...owner.headers, "x-correlation-id": randomUUID() },
        payload: { idempotency_key: randomUUID() },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(await database.domainOutbox.count({ where: { eventType: "lab.document.ready" } })).toBe(0);
  });

  test("publishes a profile event only after an owned allowlisted observation is explicitly confirmed", async () => {
    const owner = await authorizedUser();
    const document = await database.labDocument.create({ data: {
      userId: owner.user.id, objectKey: `synthetic-labs/${randomUUID()}`, sha256: "c".repeat(64),
      mimeType: "application/pdf", sizeBytes: 1024n, consentEpoch: 1,
      idempotencyKey: randomUUID(), requestHash: "d".repeat(64), status: "completed",
    } });
    const observation = await database.labObservation.create({ data: {
      documentId: document.id, code: "URIC_ACID", value: "7.1", unit: "mg/dL",
      normalizedValue: 422.308, normalizedUnit: "umol/L", page: 1,
      evidenceBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, confidence: 0.75,
      dispositionCode: "low_confidence", observationHash: "e".repeat(64), confirmationStatus: "needs_confirmation",
    } });
    expect(await database.profileEvent.count()).toBe(0);

    const confirmation = {
      idempotency_key: randomUUID(), expected_version: 1,
      code: "URIC_ACID", value: 420, unit: "umol/L",
    };
    const confirmed = await app.inject({
      method: "POST", url: `/labs/observations/${observation.id}/confirm`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: confirmation,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ confirmation_status: "usable", normalized_value: 420, normalized_unit: "umol/L" });
    expect(await database.profileEvent.count({ where: { eventType: "lab_value_corrected" } })).toBe(1);
    expect(await database.auditLog.count({ where: { action: "lab.observation.user_confirmed" } })).toBe(1);
    const replay = await app.inject({
      method: "POST", url: `/labs/observations/${observation.id}/confirm`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() }, payload: confirmation,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(confirmed.json());
    expect(await database.profileEvent.count({ where: { eventType: "lab_value_corrected" } })).toBe(1);

    const stranger = await authorizedUser();
    const hidden = await app.inject({
      method: "POST", url: `/labs/observations/${observation.id}/confirm`,
      headers: { ...stranger.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID(), expected_version: 2, code: "URIC_ACID", value: 420, unit: "umol/L" },
    });
    expect(hidden.statusCode).toBe(404);
  });

  test("requires scoped reviewer authority and records reviewer confirmation without exposing raw values in audit", async () => {
    const owner = await authorizedUser();
    const document = await database.labDocument.create({ data: {
      userId: owner.user.id, objectKey: `synthetic-labs/${randomUUID()}`, sha256: "f".repeat(64),
      mimeType: "application/pdf", sizeBytes: 1024n, consentEpoch: 1,
      idempotencyKey: randomUUID(), requestHash: "1".repeat(64), status: "completed",
    } });
    const observation = await database.labObservation.create({ data: {
      documentId: document.id, code: "ALT", value: "26", unit: "U/L",
      normalizedValue: 26, normalizedUnit: "U/L", page: 1,
      evidenceBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, confidence: 0.995,
      dispositionCode: "awaiting_confirmation", observationHash: "2".repeat(64), confirmationStatus: "needs_confirmation",
    } });
    const lookupHash = randomBytes(32).toString("hex");
    const actor = await database.adminActor.create({ data: {
      lookupHash, displayLabel: "Synthetic Lab Reviewer",
      roles: { create: [{ role: "reviewer" }] },
      subjectScopes: { create: [{ userId: owner.user.id }] },
    } });
    const token = `labs-review-${randomUUID()}`;
    adminVerifier.tokens.set(token, { lookupHash, mfa: true });

    const response = await app.inject({
      method: "POST", url: `/admin/labs/observations/${observation.id}/confirm`,
      headers: { authorization: `Bearer ${token}`, "x-correlation-id": randomUUID() },
      payload: {
        idempotency_key: randomUUID(), expected_version: 1,
        code: "ALT", value: 26, unit: "U/L", reason: "synthetic_evidence_verified",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ confirmation_status: "usable", disposition_code: "reviewer_confirmed" });
    const audit = await database.auditLog.findFirstOrThrow({ where: { action: "lab.observation.reviewer_confirmed" } });
    expect(audit).toMatchObject({ adminActorId: actor.id, beforeJson: null, afterJson: null });
    expect(audit.afterHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("linearizes concurrent confirmations into one profile event and one explicit conflict", async () => {
    const owner = await authorizedUser();
    const document = await database.labDocument.create({ data: {
      userId: owner.user.id, objectKey: `synthetic-labs/${randomUUID()}`, sha256: "3".repeat(64),
      mimeType: "application/pdf", sizeBytes: 1024n, consentEpoch: 1,
      idempotencyKey: randomUUID(), requestHash: "4".repeat(64), status: "completed",
    } });
    const observation = await database.labObservation.create({ data: {
      documentId: document.id, code: "AST", value: "24", unit: "U/L",
      normalizedValue: 24, normalizedUnit: "U/L", page: 1,
      evidenceBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }, confidence: 0.995,
      dispositionCode: "awaiting_confirmation", observationHash: "5".repeat(64), confirmationStatus: "needs_confirmation",
    } });
    const attempts = await Promise.all([0, 1].map(() => app.inject({
      method: "POST", url: `/labs/observations/${observation.id}/confirm`,
      headers: { ...owner.headers, "x-correlation-id": randomUUID() },
      payload: { idempotency_key: randomUUID(), expected_version: 1, code: "AST", value: 24, unit: "U/L" },
    })));
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await database.profileEvent.count({ where: { userId: owner.user.id, eventType: "lab_value_corrected" } })).toBe(1);
    expect(await database.labObservationMutation.count({ where: { userId: owner.user.id } })).toBe(1);
  });
});
