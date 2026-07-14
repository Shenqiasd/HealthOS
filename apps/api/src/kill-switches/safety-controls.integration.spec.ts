import { createHash, randomUUID } from "node:crypto";

import { ValidationPipe } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";

import { AdminIdentityVerifier, type VerifiedAdminIdentity } from "../admin/admin-identity.verifier";
import { AppModule } from "../app.module";
import { DatabaseService } from "../database/prisma.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";

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

describe("audited safety controls", () => {
  const database = new DatabaseService();
  const verifier = new FakeAdminIdentityVerifier();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await database.$connect();
    const module_ = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AdminIdentityVerifier)
      .useValue(verifier)
      .compile();
    app = module_.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => { await app.close(); await database.$disconnect(); });

  beforeEach(async () => {
    verifier.tokens.clear();
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, admin_actors, audit_logs, safety_control_revisions,
        safety_control_mutations RESTART IDENTITY CASCADE
    `);
  });

  async function actor(label: string, role: "reviewer" | "operator" | "admin", mfa = true) {
    const hash = lookupHash(label);
    const created = await database.adminActor.create({ data: {
      lookupHash: hash,
      displayLabel: `Synthetic ${label}`,
      roles: { create: [{ role }] },
    } });
    const token = `admin-${label}`;
    verifier.tokens.set(token, { lookupHash: hash, mfa });
    return { actor: created, headers: { authorization: `Bearer ${token}` } };
  }

  const command = {
    control_type: "kill_switch",
    control_key: "global.proactive_messages",
    scope_type: "global",
    scope_id: "*",
    active: true,
    expected_version: 0,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    reason: "incident_containment",
  };

  test("requires MFA operations authority and returns only bounded control metadata", async () => {
    const reviewer = await actor("reviewer", "reviewer");
    const noMfa = await actor("no-mfa", "operator", false);
    const operator = await actor("operator", "operator");
    expect((await app.inject({ method: "POST", url: "/admin/safety-controls/actions", payload: command })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers: noMfa.headers, payload: command })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers: {
      ...reviewer.headers, "x-correlation-id": randomUUID(),
    }, payload: command })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers: {
      ...operator.headers, "x-correlation-id": "invalid",
    }, payload: command })).statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/admin/safety-controls", headers: operator.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ schema_version: 1, controls: [] });
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { ...command, control_type: "feature_flag", idempotency_key: randomUUID() },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: {
        ...command,
        idempotency_key: randomUUID(),
        reason: "张三 UUID 00000000-0000-4000-8000-000000000001 血糖 9.8",
      },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: {
        ...command,
        control_key: "feature.daily_recommendations",
        idempotency_key: randomUUID(),
      },
    })).statusCode).toBe(400);
  });

  test("creates one immutable revision with exact replay and same-transaction audit consumption", async () => {
    const operator = await actor("operator", "operator");
    const correlationId = randomUUID();
    const headers = { ...operator.headers, "x-correlation-id": correlationId };
    const created = await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers, payload: command });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      schema_version: 1,
      control_type: "kill_switch",
      control_key: "global.proactive_messages",
      scope_type: "global",
      scope_id: "*",
      active: true,
      version: 1,
    });
    const replay = await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers, payload: command });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    expect(await database.safetyControlRevision.count()).toBe(1);
    expect(await database.safetyControlMutation.count()).toBe(1);
    expect(await database.auditLog.findFirst()).toMatchObject({
      action: "safety_control.activate",
      adminActorId: operator.actor.id,
      actorRole: "operator",
      correlationId,
      operationVersion: 1,
    });
    expect(await database.safetyControlAuditConsumption.count()).toBe(1);
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions", headers,
      payload: { ...command, active: false },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions", headers,
      payload: { ...command, idempotency_key: randomUUID() },
    })).statusCode).toBe(409);
  });

  test("keeps idempotency global and accepts exactly one concurrent next revision", async () => {
    const epochBefore = await database.safetyControlEpoch.findUniqueOrThrow({ where: { id: "global" } });
    const first = await actor("first-operator", "operator");
    const second = await actor("second-operator", "operator");
    const sharedKey = randomUUID();
    const firstResponse = await app.inject({
      method: "POST",
      url: "/admin/safety-controls/actions",
      headers: { ...first.headers, "x-correlation-id": randomUUID() },
      payload: { ...command, idempotency_key: sharedKey },
    });
    expect(firstResponse.statusCode).toBe(200);
    const crossActorReplay = await app.inject({
      method: "POST",
      url: "/admin/safety-controls/actions",
      headers: { ...second.headers, "x-correlation-id": randomUUID() },
      payload: { ...command, idempotency_key: sharedKey },
    });
    expect(crossActorReplay.statusCode).toBe(200);
    expect(crossActorReplay.json()).toEqual(firstResponse.json());

    const next = { ...command, active: false, expected_version: 1 };
    const attempts = await Promise.all([
      app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers: {
        ...first.headers, "x-correlation-id": randomUUID(),
      }, payload: { ...next, idempotency_key: randomUUID() } }),
      app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers: {
        ...second.headers, "x-correlation-id": randomUUID(),
      }, payload: { ...next, idempotency_key: randomUUID() } }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await database.safetyControlRevision.count()).toBe(2);
    expect(await database.safetyControlEpoch.findUniqueOrThrow({ where: { id: "global" } }))
      .toMatchObject({ version: epochBefore.version + 2n });
  });

  test("feature flags fail closed and observe every committed revision without a stale cache", async () => {
    const flags = app.get(FeatureFlagsService);
    const operator = await actor("flag-operator", "operator");
    const headers = { ...operator.headers, "x-correlation-id": randomUUID() };
    const input = {
      control_type: "feature_flag",
      control_key: "feature.daily_recommendations",
      scope_type: "global",
      scope_id: "*",
      active: true,
      expected_version: 0,
      idempotency_key: randomUUID(),
      reason: "staged_rollout",
    };
    await expect(flags.evaluate("feature.daily_recommendations", { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: false, reason: "missing_revision_fail_closed", version: 0 });
    expect((await app.inject({ method: "POST", url: "/admin/safety-controls/actions", headers, payload: input })).statusCode)
      .toBe(200);
    await expect(flags.evaluate("feature.daily_recommendations", { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: true, reason: "enabled_revision", version: 1 });
    expect((await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { ...input, active: false, expected_version: 1, idempotency_key: randomUUID() },
    })).statusCode).toBe(200);
    await expect(flags.evaluate("feature.daily_recommendations", { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: false, reason: "disabled_revision", version: 2 });
  });

  test("operates LLM generation only through the audited global feature-flag path", async () => {
    const flags = app.get(FeatureFlagsService);
    const operator = await actor("llm-flag-operator", "operator");
    const headers = { ...operator.headers, "x-correlation-id": randomUUID() };
    const input = {
      control_type: "feature_flag",
      control_key: "feature.llm_generation",
      scope_type: "global",
      scope_id: "*",
      active: true,
      expected_version: 0,
      idempotency_key: randomUUID(),
      reason: "staged_rollout",
    };

    await expect(flags.evaluate("feature.llm_generation" as never, { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: false, reason: "missing_revision_fail_closed", version: 0 });

    const created = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions", headers, payload: input,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      control_type: "feature_flag",
      control_key: "feature.llm_generation",
      scope_type: "global",
      scope_id: "*",
      active: true,
      version: 1,
    });
    const replay = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions", headers, payload: input,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    expect(await database.safetyControlRevision.count({
      where: { controlType: "feature_flag", controlKey: "feature.llm_generation" },
    })).toBe(1);
    expect(await database.safetyControlAuditConsumption.count()).toBe(1);
    await expect(flags.evaluate("feature.llm_generation" as never, { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: true, reason: "enabled_revision", version: 1 });

    const wrongType = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: { ...input, control_type: "kill_switch", idempotency_key: randomUUID() },
    });
    expect(wrongType.statusCode).toBe(400);
    const wrongScope = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: {
        ...input,
        scope_type: "channel",
        scope_id: "apns",
        idempotency_key: randomUUID(),
      },
    });
    expect(wrongScope.statusCode).toBe(400);

    const next = { ...input, active: false, expected_version: 1 };
    const attempts = await Promise.all([
      app.inject({
        method: "POST", url: "/admin/safety-controls/actions",
        headers: { ...operator.headers, "x-correlation-id": randomUUID() },
        payload: { ...next, idempotency_key: randomUUID() },
      }),
      app.inject({
        method: "POST", url: "/admin/safety-controls/actions",
        headers: { ...operator.headers, "x-correlation-id": randomUUID() },
        payload: { ...next, idempotency_key: randomUUID() },
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await expect(flags.evaluate("feature.llm_generation" as never, { type: "global", id: "*" }))
      .resolves.toMatchObject({ enabled: false, reason: "disabled_revision", version: 2 });
  });

  test("database rejects unaudited, invalid-scope, and mutable control evidence", async () => {
    const operator = await actor("db-operator", "operator");
    await expect(database.safetyControlRevision.create({ data: {
      controlType: "kill_switch",
      controlKey: "global.proactive_messages",
      scopeType: "global",
      scopeId: "*",
      active: true,
      version: 1,
      reason: "synthetic_test",
      adminActorId: operator.actor.id,
      correlationId: randomUUID(),
    } })).rejects.toThrow(/audit/i);

    const apiActor = await actor("append-only", "operator");
    const created = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...apiActor.headers, "x-correlation-id": randomUUID() }, payload: command,
    });
    expect(created.statusCode).toBe(200);
    const revision = await database.safetyControlRevision.findFirstOrThrow();
    const mutation = await database.safetyControlMutation.findFirstOrThrow();
    await expect(database.safetyControlRevision.update({
      where: { id: revision.id }, data: { reason: "incident_recovery" },
    })).rejects.toThrow(/append-only/i);
    await expect(database.safetyControlMutation.delete({ where: { id: mutation.id } }))
      .rejects.toThrow(/append-only/i);
    await expect(database.safetyControlEpoch.update({
      where: { id: "global" }, data: { version: { increment: 1 } },
    })).rejects.toThrow(/protected singleton/i);
    await expect(database.safetyControlEpoch.delete({ where: { id: "global" } }))
      .rejects.toThrow(/protected singleton/i);
  });

  test("database binds audit hashes and claimed role to the same-transaction revision", async () => {
    const operator = await actor("forged-audit", "operator");
    const attempt = async (actorRole: "operator" | "admin", forgeHashes: boolean) => {
      await database.$transaction(async (tx) => {
        const revisionId = randomUUID();
        const correlationId = randomUUID();
        const [snapshot] = await tx.$queryRaw<Array<{
          after_json: Prisma.JsonValue;
          before_hash: string;
          after_hash: string;
        }>>`
          SELECT
            healthos_safety_control_snapshot(
              'kill_switch', 'global.proactive_messages', 'global', '*', true, 1, 'synthetic_test'
            ) AS "after_json",
            encode(digest('null'::jsonb::text, 'sha256'), 'hex') AS "before_hash",
            encode(digest(healthos_safety_control_snapshot(
              'kill_switch', 'global.proactive_messages', 'global', '*', true, 1, 'synthetic_test'
            )::text, 'sha256'), 'hex') AS "after_hash"
        `;
        if (!snapshot) throw new Error("Synthetic audit snapshot missing");
        const audit = await tx.auditLog.create({ data: {
          adminActorId: operator.actor.id,
          actorRole,
          action: "safety_control.activate",
          resourceType: "safety_control",
          resourceId: revisionId,
          reason: "synthetic_test",
          correlationId,
          beforeJson: Prisma.DbNull,
          afterJson: snapshot.after_json as Prisma.InputJsonValue,
          beforeHash: forgeHashes ? "0".repeat(64) : snapshot.before_hash,
          afterHash: forgeHashes ? "f".repeat(64) : snapshot.after_hash,
          operationVersion: 1,
        } });
        await tx.$executeRaw`SELECT set_config('healthos.safety_control_audit_id', ${audit.id}, true)`;
        await tx.safetyControlRevision.create({ data: {
          id: revisionId,
          controlType: "kill_switch",
          controlKey: "global.proactive_messages",
          scopeType: "global",
          scopeId: "*",
          active: true,
          version: 1,
          reason: "synthetic_test",
          adminActorId: operator.actor.id,
          correlationId,
        } });
      });
    };
    await expect(attempt("admin", false)).rejects.toThrow(/audit/i);
    await expect(attempt("operator", true)).rejects.toThrow(/audit/i);
  });

  test("privacy deletion removes user-scoped controls without erasing deidentified audit evidence", async () => {
    const operator = await actor("privacy-operator", "operator");
    const user = await database.user.create({ data: { status: "deleting", deletedAt: new Date() } });
    const response = await app.inject({
      method: "POST", url: "/admin/safety-controls/actions",
      headers: { ...operator.headers, "x-correlation-id": randomUUID() },
      payload: {
        ...command,
        control_key: "user.recommendations",
        scope_type: "user",
        scope_id: user.id,
        idempotency_key: randomUUID(),
        reason: "privacy_containment",
      },
    });
    expect(response.statusCode).toBe(200);
    const audit = await database.auditLog.findFirstOrThrow({ where: { action: "safety_control.activate" } });
    expect(JSON.stringify(audit.afterJson)).not.toContain(user.id);
    expect(audit.reason).toBe("privacy_containment");
    await database.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
    expect(await database.safetyControlRevision.count({ where: { subjectUserId: user.id } })).toBe(0);
    expect(await database.safetyControlMutation.count({ where: { subjectUserId: user.id } })).toBe(0);
    expect(await database.auditLog.count({ where: { id: audit.id } })).toBe(1);
  });
});
