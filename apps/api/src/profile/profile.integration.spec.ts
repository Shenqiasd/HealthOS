import { randomUUID } from "node:crypto";

import { DatabaseService } from "../database/prisma.service";
import { ProfileCandidateService } from "./profile-candidate.service";
import { canonicalSha256 } from "./canonical-json";
import { ProfileEventService } from "./profile-event.service";
import { ProfileSnapshotService } from "./profile-snapshot.service";

describe("profile event ledger integration", () => {
  const database = new DatabaseService();
  const events = new ProfileEventService(database);
  const candidates = new ProfileCandidateService(database, events);
  const snapshots = new ProfileSnapshotService(database);

  beforeAll(async () => database.$connect());

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        consumer_inbox,
        domain_outbox_consent_requirements,
        domain_outbox,
        profile_snapshots,
        profile_events,
        profile_candidates,
        consent_records,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => database.$disconnect());

  async function authorizedUser() {
    const user = await database.user.create({ data: { consentEpoch: 1 } });
    await database.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "health-v1",
        granted: true,
        epoch: 1,
        correlationId: randomUUID(),
        requestHash: "synthetic-profile-consent",
        source: "synthetic",
      },
    });
    return user;
  }

  test("appends allowlisted events atomically and makes correlation replay idempotent", async () => {
    const user = await authorizedUser();
    const correlationId = randomUUID();
    const input = {
      eventType: "limitation_confirmed" as const,
      source: "synthetic_user_confirmation",
      correlationId,
      payload: { code: "knee_discomfort", active: true },
    };
    const first = await events.append(user.id, input);
    const replay = await events.append(user.id, input);

    expect(replay).toEqual(first);
    expect(await database.profileEvent.count()).toBe(1);
    expect(await database.domainOutbox.count({
      where: { eventType: "profile.event.appended" },
    })).toBe(1);
    await expect(events.append(user.id, {
      ...input,
      payload: { code: "knee_discomfort", active: false },
    })).rejects.toThrow(/correlation|reused|idempotency/i);
  });

  test("rejects unsupported free text before it becomes a profile event", async () => {
    const user = await authorizedUser();
    await expect(events.append(user.id, {
      eventType: "coach_free_text" as never,
      source: "coach",
      correlationId: randomUUID(),
      payload: { text: "I cannot walk today" },
    })).rejects.toThrow(/allowlist|unsupported|event type/i);
    expect(await database.profileEvent.count()).toBe(0);
  });

  test("keeps free text out of the ledger until a structured candidate is confirmed", async () => {
    const user = await authorizedUser();
    const candidate = await candidates.propose(user.id, {
      candidateType: "mobility_limitation",
      structuredValue: { code: "knee_discomfort", active: true },
      sourceText: "My knee hurts when I walk",
      idempotencyKey: randomUUID(),
    });
    expect(await database.profileEvent.count()).toBe(0);

    const event = await candidates.confirm(user.id, candidate.id, randomUUID());
    expect(event.eventType).toBe("limitation_confirmed");
    expect(JSON.stringify(event.payload)).not.toContain("My knee hurts");
    expect((await database.profileCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    })).sourceTextHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("database blocks ordinary update and delete of ledger rows for active users", async () => {
    const user = await authorizedUser();
    const event = await events.append(user.id, {
      eventType: "limitation_confirmed",
      source: "synthetic_user_confirmation",
      correlationId: randomUUID(),
      payload: { code: "knee_discomfort", active: true },
    });
    await expect(database.profileEvent.update({
      where: { id: event.id },
      data: { source: "tampered" },
    })).rejects.toThrow(/append-only|immutable/i);
    await expect(database.profileEvent.delete({ where: { id: event.id } }))
      .rejects.toThrow(/append-only|immutable/i);
    await database.$executeRawUnsafe("DROP ROLE IF EXISTS healthos_t019_app_test");
    await database.$executeRawUnsafe("CREATE ROLE healthos_t019_app_test NOLOGIN");
    await database.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO healthos_t019_app_test",
    );
    await database.$executeRawUnsafe(
      "GRANT SELECT, DELETE ON profile_events TO healthos_t019_app_test",
    );
    await expect(database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE healthos_t019_app_test");
      await tx.$executeRawUnsafe("SET LOCAL healthos.allow_privacy_delete = 'on'");
      await tx.profileEvent.delete({ where: { id: event.id } });
    })).rejects.toThrow(/append-only|immutable/i);
    await database.$executeRawUnsafe(
      "REVOKE SELECT, DELETE ON profile_events FROM healthos_t019_app_test",
    );
    await database.$executeRawUnsafe(
      "REVOKE USAGE ON SCHEMA public FROM healthos_t019_app_test",
    );
    await database.$executeRawUnsafe("DROP ROLE healthos_t019_app_test");
  });

  test("canonical hashing ignores object key order but not array order or values", () => {
    expect(canonicalSha256({ nested: { b: 2, a: 1 }, items: [1, 2] }))
      .toBe(canonicalSha256({ items: [1, 2], nested: { a: 1, b: 2 } }));
    expect(canonicalSha256({ items: [1, 2] }))
      .not.toBe(canonicalSha256({ items: [2, 1] }));
    expect(canonicalSha256({ value: 1 }))
      .not.toBe(canonicalSha256({ value: 2 }));
  });

  test("candidate content is immutable and concurrent confirmation creates one event", async () => {
    const user = await authorizedUser();
    const candidate = await candidates.propose(user.id, {
      candidateType: "mobility_limitation",
      structuredValue: { code: "knee_discomfort", active: true },
      sourceText: "Synthetic candidate text",
      idempotencyKey: randomUUID(),
    });
    await expect(database.profileCandidate.update({
      where: { id: candidate.id },
      data: { structuredValueJson: { code: "different", active: false } },
    })).rejects.toThrow(/immutable/i);

    const [first, second] = await Promise.all([
      candidates.confirm(user.id, candidate.id, randomUUID()),
      candidates.confirm(user.id, candidate.id, randomUUID()),
    ]);
    expect(second.id).toBe(first.id);
    expect(await database.profileEvent.count()).toBe(1);
    expect(await database.domainOutbox.count()).toBe(1);
  });

  test("database rejects cross-user snapshot provenance", async () => {
    const sourceUser = await authorizedUser();
    const otherUser = await authorizedUser();
    const event = await events.append(sourceUser.id, {
      eventType: "limitation_confirmed",
      source: "synthetic_user_confirmation",
      correlationId: randomUUID(),
      payload: { code: "knee_discomfort", active: true },
    });
    await expect(database.profileSnapshot.create({
      data: {
        userId: otherUser.id,
        version: 1,
        factsJson: {},
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        consentEpoch: 1,
        snapshotHash: "b".repeat(64),
      },
    })).rejects.toThrow();
  });

  test("withdrawal makes a committed snapshot unreadable", async () => {
    const user = await authorizedUser();
    const event = await events.append(user.id, {
      eventType: "limitation_confirmed",
      source: "synthetic_user_confirmation",
      correlationId: randomUUID(),
      payload: { code: "knee_discomfort", active: true },
    });
    await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 1,
        factsJson: { limitations: { knee_discomfort: { active: true } } },
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        consentEpoch: 1,
        snapshotHash: "c".repeat(64),
      },
    });
    await expect(snapshots.current(user.id)).resolves.toMatchObject({ version: 1 });
    await database.consentRecord.create({
      data: {
        userId: user.id,
        consentType: "health_processing",
        documentVersion: "health-v1",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      },
    });
    await database.user.update({ where: { id: user.id }, data: { consentEpoch: 2 } });
    await expect(snapshots.current(user.id)).rejects.toThrow(/consent/i);
  });

  test("security-definer privacy deletion can remove an authorized frozen ledger", async () => {
    const user = await authorizedUser();
    const event = await events.append(user.id, {
      eventType: "limitation_confirmed",
      source: "synthetic_user_confirmation",
      correlationId: randomUUID(),
      payload: { code: "knee_discomfort", active: true },
    });
    await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 1,
        factsJson: {},
        sourceEventUntil: event.id,
        sourceSequence: event.sequence,
        consentEpoch: 1,
        snapshotHash: "d".repeat(64),
      },
    });
    await database.user.update({
      where: { id: user.id },
      data: { status: "deleting", deletedAt: new Date() },
    });
    await database.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'healthos_privacy_worker'
        ) THEN
          CREATE ROLE healthos_privacy_worker NOLOGIN;
        END IF;
      END;
      $role$
    `);
    await database.$executeRawUnsafe(
      "GRANT EXECUTE ON FUNCTION healthos_delete_frozen_user(UUID) TO healthos_privacy_worker",
    );
    await database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE healthos_privacy_worker");
      await tx.$queryRaw`SELECT "healthos_delete_frozen_user"(${user.id}::uuid)`;
    });
    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
    expect(await database.profileEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await database.profileSnapshot.count({ where: { userId: user.id } })).toBe(0);
  });
});
