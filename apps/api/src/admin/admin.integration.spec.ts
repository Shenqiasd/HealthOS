import { createHash, randomUUID } from "node:crypto";

import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "../app.module";
import { DatabaseService } from "../database/prisma.service";
import { AdminIdentityVerifier, type VerifiedAdminIdentity } from "./admin-identity.verifier";
import { resolveAdminCursorSigningSecret } from "./admin.module";

class FakeAdminIdentityVerifier extends AdminIdentityVerifier {
  readonly tokens = new Map<string, VerifiedAdminIdentity>();

  async verify(token: string): Promise<VerifiedAdminIdentity> {
    const identity = this.tokens.get(token);
    if (!identity) throw new Error("untrusted administrator token");
    return identity;
  }
}

function lookupHash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

describe("operations control API", () => {
  const database = new DatabaseService();
  const verifier = new FakeAdminIdentityVerifier();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await database.$connect();
    const testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdminIdentityVerifier)
      .useValue(verifier)
      .compile();
    app = testingModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  test("fails closed without a production cursor signing secret", () => {
    expect(() => resolveAdminCursorSigningSecret({ NODE_ENV: "production" })).toThrow(
      /cursor signing secret/i,
    );
    expect(resolveAdminCursorSigningSecret({ NODE_ENV: "test" }).length).toBeGreaterThanOrEqual(32);
  });

  afterAll(async () => {
    await app.close();
    await database.$disconnect();
  });

  beforeEach(async () => {
    verifier.tokens.clear();
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation
      RESTART IDENTITY CASCADE
    `);
    await database.privacyReconciliation.create({ data: { id: "global", status: "ready" } });
  });

  async function actor(input: {
    label: string;
    roles: Array<"reviewer" | "operator" | "admin" | "medical_approver">;
    scopedUserIds?: string[];
    mfa?: boolean;
    status?: "active" | "disabled";
  }) {
    const hash = lookupHash(input.label);
    const created = await database.adminActor.create({
      data: {
        lookupHash: hash,
        displayLabel: `Synthetic ${input.label}`,
        status: input.status ?? "active",
        roles: { create: input.roles.map((role) => ({ role })) },
        subjectScopes: { create: (input.scopedUserIds ?? []).map((userId) => ({ userId })) },
      },
    });
    const token = `admin-${input.label}`;
    verifier.tokens.set(token, { lookupHash: hash, mfa: input.mfa ?? true });
    return { actor: created, headers: { authorization: `Bearer ${token}` } };
  }

  async function fixtures() {
    const firstUser = await database.user.create({ data: {} });
    const secondUser = await database.user.create({ data: {} });
    const firstTask = await database.reviewTask.create({ data: {
      taskType: "recommendation_triage", subjectId: randomUUID(), userId: firstUser.id,
      priority: "high", slaAt: new Date("2026-07-11T10:00:00.000Z"),
    } });
    const secondTask = await database.reviewTask.create({ data: {
      taskType: "recommendation_triage", subjectId: randomUUID(), userId: secondUser.id,
      priority: "normal", slaAt: new Date("2026-07-11T11:00:00.000Z"),
    } });
    const incident = await database.safetyIncident.create({ data: {
      userId: firstUser.id, source: "rule:synthetic", severity: "high",
      detailsEncrypted: "ciphertext-never-returned",
    } });
    const safetyTask = await database.reviewTask.create({ data: {
      taskType: "safety_incident", subjectId: incident.id, userId: firstUser.id,
      priority: "urgent", slaAt: new Date("2026-07-11T09:00:00.000Z"),
    } });
    return { firstUser, secondUser, firstTask, secondTask, incident, safetyTask };
  }

  test("fails closed for missing, user, non-MFA, and inactive administrator identities", async () => {
    const data = await fixtures();
    const valid = await actor({ label: "reviewer", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const noMfa = await actor({ label: "no-mfa", roles: ["reviewer"], scopedUserIds: [data.firstUser.id], mfa: false });
    const disabled = await actor({ label: "disabled", roles: ["reviewer"], scopedUserIds: [data.firstUser.id], status: "disabled" });
    expect((await app.inject({ method: "GET", url: "/admin/review-tasks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/review-tasks", headers: { authorization: "Bearer user-access-token" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/review-tasks", headers: noMfa.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/review-tasks", headers: disabled.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/review-tasks", headers: valid.headers })).statusCode).toBe(200);
  });

  test("paginates a stable least-SLA queue and never leaks an actor's unscoped subjects", async () => {
    const data = await fixtures();
    const reviewer = await actor({ label: "scoped", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const laterTask = await database.reviewTask.create({ data: {
      taskType: "feedback_attention", subjectId: randomUUID(), userId: data.firstUser.id,
      priority: "normal", slaAt: new Date("2026-07-11T12:00:00.000Z"),
    } });
    const response = await app.inject({ method: "GET", url: "/admin/review-tasks?limit=1", headers: reviewer.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: data.firstTask.id, version: 1 }], next_cursor: expect.any(String) });
    const cursor = response.json().next_cursor as string;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expect((await app.inject({ method: "GET", url: `/admin/review-tasks?limit=1&cursor=${encodeURIComponent(tampered)}`, headers: reviewer.headers })).statusCode).toBe(400);
    const claimLater = await app.inject({
      method: "POST", url: `/admin/review-tasks/${laterTask.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": randomUUID() },
      payload: { action: "claim", expected_version: 1, reason: "Snapshot membership test" },
    });
    expect(claimLater.statusCode).toBe(200);
    const insertedAfterSnapshot = await database.reviewTask.create({ data: {
      taskType: "feedback_attention", subjectId: randomUUID(), userId: data.firstUser.id,
      priority: "normal", slaAt: new Date("2026-07-11T11:30:00.000Z"),
    } });
    const secondPage = await app.inject({
      method: "GET", url: `/admin/review-tasks?limit=1&cursor=${encodeURIComponent(cursor)}`, headers: reviewer.headers,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({ items: [{ id: laterTask.id, status: "active" }], next_cursor: null });
    expect(secondPage.body).not.toContain(insertedAfterSnapshot.id);
    const otherReviewer = await actor({ label: "other-scoped", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    expect((await app.inject({
      method: "GET", url: `/admin/review-tasks?limit=1&cursor=${encodeURIComponent(cursor)}`, headers: otherReviewer.headers,
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET", url: `/admin/review-tasks?limit=1&status=pending&cursor=${encodeURIComponent(cursor)}`, headers: reviewer.headers,
    })).statusCode).toBe(400);
    await database.adminActorSubjectScope.delete({
      where: { actorId_userId: { actorId: reviewer.actor.id, userId: data.firstUser.id } },
    });
    expect((await app.inject({
      method: "GET", url: `/admin/review-tasks?limit=1&cursor=${encodeURIComponent(cursor)}`, headers: reviewer.headers,
    })).statusCode).toBe(400);
    expect(response.body).not.toContain(data.secondTask.id);
    expect(secondPage.body).not.toContain(data.firstTask.id);
    expect(response.body).not.toMatch(/canonical|raw_value|details_encrypted|ciphertext/i);
  });

  test("claims, reassigns, and releases with version fencing, reasons, scope, and atomic audit", async () => {
    const data = await fixtures();
    const reviewer = await actor({ label: "primary", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const backup = await actor({ label: "backup", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const operator = await actor({ label: "operator", roles: ["operator"] });
    const correlationId = randomUUID();
    expect((await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { action: "reassign", expected_version: 1, reason: "Missing backup assignee" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": randomUUID() },
      payload: { action: "claim", expected_version: 1, assignee_id: backup.actor.id, reason: "Claim cannot choose assignee" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.secondTask.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": randomUUID() },
      payload: { action: "claim", expected_version: 1, reason: "Cross-scope attempt" },
    })).statusCode).toBe(404);
    const claimed = await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": correlationId },
      payload: { action: "claim", expected_version: 1, reason: "Begin synthetic review" },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ status: "active", assignee_id: reviewer.actor.id, version: 2 });
    expect(await database.auditLog.count()).toBe(1);
    expect(await database.auditLog.findFirst()).toMatchObject({
      adminActorId: reviewer.actor.id, actorRole: "reviewer", reason: "Begin synthetic review",
      correlationId, action: "operations.review_task.claim", operationVersion: 2,
    });
    expect(await database.auditLog.findFirst()).toMatchObject({
      beforeJson: { status: "pending", assignee_id: null, version: 1 },
      afterJson: { status: "active", assignee_id: reviewer.actor.id, version: 2 },
    });

    const stale = await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": randomUUID() },
      payload: { action: "release", expected_version: 1, reason: "stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(await database.auditLog.count()).toBe(1);

    const missingReason = await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: operator.headers,
      payload: { action: "reassign", expected_version: 2, assignee_id: backup.actor.id, reason: "" },
    });
    expect(missingReason.statusCode).toBe(400);
    const reassigned = await app.inject({
      method: "POST", url: `/admin/review-tasks/${data.firstTask.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { action: "reassign", expected_version: 2, assignee_id: backup.actor.id, reason: "Backup takeover" },
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json()).toMatchObject({ assignee_id: backup.actor.id, version: 3 });

    const beforeDirectWrite = await database.reviewTask.findUniqueOrThrow({ where: { id: data.firstTask.id } });
    await expect(database.reviewTask.update({
      where: { id: data.firstTask.id },
      data: { status: "completed", version: { increment: 1 }, updatedAt: new Date(beforeDirectWrite.updatedAt.getTime() + 1) },
    })).rejects.toThrow(/operations audit/i);
    expect((await database.reviewTask.findUniqueOrThrow({ where: { id: data.firstTask.id } })).status).toBe("active");
  });

  test("enforces incident roles, allowlisted transitions, scope, and encrypted-detail redaction", async () => {
    const data = await fixtures();
    const reviewer = await actor({ label: "incident-reviewer", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const operator = await actor({ label: "incident-operator", roles: ["operator"] });
    const listed = await app.inject({ method: "GET", url: "/admin/safety-incidents", headers: operator.headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toMatch(/ciphertext|details_encrypted/i);
    expect((await app.inject({
      method: "POST", url: `/admin/safety-incidents/${data.incident.id}/actions`, headers: { ...reviewer.headers, "x-correlation-id": randomUUID() },
      payload: { action: "acknowledge", expected_version: 1, reason: "Not permitted" },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: `/admin/safety-incidents/${data.incident.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { action: "acknowledge", expected_version: 1, assignee_id: operator.actor.id, reason: "Assignee is server-owned" },
    })).statusCode).toBe(400);
    for (const forbiddenAssignee of [null, ""]) {
      expect((await app.inject({
        method: "POST", url: `/admin/safety-incidents/${data.incident.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
        payload: { action: "acknowledge", expected_version: 1, assignee_id: forbiddenAssignee, reason: "Assignee field is forbidden" },
      })).statusCode).toBe(400);
    }
    const acknowledged = await app.inject({
      method: "POST", url: `/admin/safety-incidents/${data.incident.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { action: "acknowledge", expected_version: 1, reason: "Investigating synthetic incident" },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ status: "active", version: 2 });
    expect(acknowledged.body).not.toContain("rule:synthetic");
    const invalid = await app.inject({
      method: "POST", url: `/admin/safety-incidents/${data.incident.id}/actions`, headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { action: "acknowledge", expected_version: 2, reason: "Invalid repeat" },
    });
    expect(invalid.statusCode).toBe(409);
    const currentTask = await database.reviewTask.findUniqueOrThrow({ where: { id: data.safetyTask.id } });
    const before = { status: currentTask.status, assignee_id: currentTask.assigneeId, version: currentTask.version };
    const after = { status: "completed", assignee_id: currentTask.assigneeId, version: currentTask.version + 1 };
    await expect(database.$transaction(async (tx) => {
      const [hashes] = await tx.$queryRaw<Array<{ before_hash: string; after_hash: string }>>`
        SELECT encode(digest(${JSON.stringify(before)}::jsonb::text, 'sha256'), 'hex') AS "before_hash",
               encode(digest(${JSON.stringify(after)}::jsonb::text, 'sha256'), 'hex') AS "after_hash"
      `;
      if (!hashes) throw new Error("missing hashes");
      const forged = await tx.auditLog.create({ data: {
        adminActorId: reviewer.actor.id, actorRole: "reviewer", action: "operations.safety_incident.resolve",
        resourceType: "safety_incident", resourceId: data.incident.id, reason: "Forged complete audit",
        correlationId: randomUUID(), beforeJson: before, afterJson: after,
        beforeHash: hashes.before_hash, afterHash: hashes.after_hash, operationVersion: currentTask.version + 1,
      } });
      await tx.$executeRaw`SELECT set_config('healthos.operations_audit_id', ${forged.id}, true)`;
      await tx.reviewTask.update({ where: { id: currentTask.id }, data: {
        status: "completed", version: { increment: 1 }, updatedAt: new Date(currentTask.updatedAt.getTime() + 1),
      } });
    })).rejects.toThrow(/not authorized/i);
    await expect(database.safetyIncident.update({
      where: { id: data.incident.id },
      data: { status: "completed" },
    })).rejects.toThrow(/append-only/i);
    expect((await database.safetyIncident.findUniqueOrThrow({ where: { id: data.incident.id } })).status).toBe("pending");
    expect((await database.reviewTask.findUniqueOrThrow({ where: { id: data.safetyTask.id } })).status).toBe("active");
  });

  test("rejects null audit fields, null assignees, and role-label privilege escalation at the database boundary", async () => {
    const data = await fixtures();
    const multiRole = await actor({ label: "multi-role", roles: ["reviewer", "operator"] });
    const before = { status: "pending", assignee_id: null, version: 1 };
    const nullAssigneeAfter = { status: "active", assignee_id: null, version: 2 };
    const assignedAfter = { status: "active", assignee_id: multiRole.actor.id, version: 2 };

    await expect(database.auditLog.create({ data: {
      adminActorId: multiRole.actor.id,
      actorRole: "reviewer",
      action: "operations.review_task.claim",
      resourceType: "review_task",
      resourceId: data.secondTask.id,
      reason: null,
      correlationId: randomUUID(),
      beforeJson: before,
      afterJson: assignedAfter,
      beforeHash: null,
      afterHash: "a".repeat(64),
      operationVersion: 2,
    } })).rejects.toThrow();

    async function attemptForgedClaim(
      after: { status: string; assignee_id: string | null; version: number },
      reason: string,
    ) {
      return database.$transaction(async (tx) => {
        const [hashes] = await tx.$queryRaw<Array<{ before_hash: string; after_hash: string }>>`
          SELECT encode(digest(${JSON.stringify(before)}::jsonb::text, 'sha256'), 'hex') AS "before_hash",
                 encode(digest(${JSON.stringify(after)}::jsonb::text, 'sha256'), 'hex') AS "after_hash"
        `;
        if (!hashes) throw new Error("missing hashes");
        const audit = await tx.auditLog.create({ data: {
          adminActorId: multiRole.actor.id,
          actorRole: "reviewer",
          action: "operations.review_task.claim",
          resourceType: "review_task",
          resourceId: data.secondTask.id,
          reason,
          correlationId: randomUUID(),
          beforeJson: before,
          afterJson: after,
          beforeHash: hashes.before_hash,
          afterHash: hashes.after_hash,
          operationVersion: 2,
        } });
        await tx.$executeRaw`SELECT set_config('healthos.operations_audit_id', ${audit.id}, true)`;
        return tx.reviewTask.update({ where: { id: data.secondTask.id }, data: {
          status: "active",
          assigneeId: after.assignee_id,
          version: 2,
          updatedAt: new Date(data.secondTask.updatedAt.getTime() + 1),
        } });
      });
    }

    await expect(attemptForgedClaim(nullAssigneeAfter, "Null assignee bypass")).rejects.toThrow(/not authorized/i);
    await expect(attemptForgedClaim(assignedAfter, "Reviewer label with operator role")).rejects.toThrow(/not authorized/i);
    expect(await database.reviewTask.findUniqueOrThrow({ where: { id: data.secondTask.id } })).toMatchObject({
      status: "pending",
      assigneeId: null,
      version: 1,
    });
  });

  test("rolls back an operations audit that is not consumed by exactly one same-transaction mutation", async () => {
    const data = await fixtures();
    const reviewer = await actor({ label: "orphan-audit", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    const before = { status: "pending", assignee_id: null, version: 1 };
    const after = { status: "active", assignee_id: reviewer.actor.id, version: 2 };
    const [hashes] = await database.$queryRaw<Array<{ before_hash: string; after_hash: string }>>`
      SELECT encode(digest(${JSON.stringify(before)}::jsonb::text, 'sha256'), 'hex') AS "before_hash",
             encode(digest(${JSON.stringify(after)}::jsonb::text, 'sha256'), 'hex') AS "after_hash"
    `;
    if (!hashes) throw new Error("missing hashes");
    await expect(database.auditLog.create({ data: {
      adminActorId: reviewer.actor.id,
      actorRole: "reviewer",
      action: "operations.review_task.claim",
      resourceType: "review_task",
      resourceId: data.firstTask.id,
      reason: "Orphan success audit",
      correlationId: randomUUID(),
      beforeJson: before,
      afterJson: after,
      beforeHash: hashes.before_hash,
      afterHash: hashes.after_hash,
      operationVersion: 2,
    } })).rejects.toThrow(/consumed|mutation/i);
    await expect(database.$transaction(async (tx) => {
      const audit = await tx.auditLog.create({ data: {
        adminActorId: reviewer.actor.id,
        actorRole: "reviewer",
        action: "operations.review_task.claim",
        resourceType: "review_task",
        resourceId: data.firstTask.id,
        reason: "Forged consumption without mutation",
        correlationId: randomUUID(),
        beforeJson: before,
        afterJson: after,
        beforeHash: hashes.before_hash,
        afterHash: hashes.after_hash,
        operationVersion: 2,
      } });
      await tx.operationAuditConsumption.create({ data: {
        auditId: audit.id,
        workItemId: data.firstTask.id,
        operationVersion: 2,
      } });
    })).rejects.toThrow(/consumed|mutation/i);
    expect(await database.auditLog.count({ where: { resourceId: data.firstTask.id } })).toBe(0);
  });

  test("exact privacy deletion removes subject scopes and operations work without deleting the synthetic actor", async () => {
    const data = await fixtures();
    const reviewer = await actor({ label: "privacy-reviewer", roles: ["reviewer"], scopedUserIds: [data.firstUser.id] });
    await database.user.update({ where: { id: data.firstUser.id }, data: { status: "deleting", deletedAt: new Date() } });
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${data.firstUser.id}::uuid)`;
    await expect(database.reviewTask.count({ where: { userId: data.firstUser.id } })).resolves.toBe(0);
    await expect(database.adminActorSubjectScope.count({ where: { userId: data.firstUser.id } })).resolves.toBe(0);
    await expect(database.adminActor.count({ where: { id: reviewer.actor.id } })).resolves.toBe(1);
    await expect(database.safetyIncident.findUniqueOrThrow({ where: { id: data.incident.id } })).resolves.toMatchObject({ userId: null });
  });
});
