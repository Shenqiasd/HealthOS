import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";

import { createApp } from "../src/main";
import { DatabaseService } from "../src/database/prisma.service";
import { PublicationRepository } from "../src/database/publication.repository";

describe("database invariants", () => {
  const database = new DatabaseService();
  const publication = new PublicationRepository(database);

  beforeAll(async () => {
    await database.$connect();
  });

  afterEach(async () => {
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE
        domain_outbox,
        action_assignments,
        recommendation_snapshots,
        recommendation_runs,
        rule_bundles,
        profile_snapshots,
        profile_events,
        lab_observations,
        lab_documents,
        channel_accounts,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  async function createRecommendationRun() {
    const user = await database.user.create({
      data: { locale: "zh-CN", timezone: "Asia/Shanghai" },
    });
    const profileEvent = await database.profileEvent.create({
      data: {
        userId: user.id,
        eventType: "synthetic_profile_created",
        source: "test",
        payload: {},
        correlationId: randomUUID(),
      },
    });
    const profile = await database.profileSnapshot.create({
      data: {
        userId: user.id,
        version: 1,
        factsJson: {},
        sourceEventUntil: profileEvent.id,
      },
    });
    const bundle = await database.ruleBundle.create({
      data: {
        version: "test-v1",
        status: "published",
        contentHash: "sha256:test-v1",
        publishedBy: "test",
        publishedAt: new Date(),
      },
    });
    const run = await database.recommendationRun.create({
      data: {
        userId: user.id,
        localDate: new Date("2026-07-10T00:00:00.000Z"),
        inputSnapshotId: profile.id,
        ruleBundleId: bundle.id,
        status: "completed",
        correlationId: randomUUID(),
      },
    });
    return { run, user };
  }

  async function createPublishedSnapshot() {
    const { run, user } = await createRecommendationRun();
    const snapshot = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 1,
        riskArea: "sleep",
        safetyClass: "normal",
        actionCode: "sleep_consistency",
        renderedPayloadJson: { title: "Synthetic action" },
        canonicalRuleInputJson: { lab_observation_ids: [] },
        provenanceJson: { synthetic: true },
        reviewStatus: "published",
      },
    });
    return { run, snapshot, user };
  }

  test("allows only one active primary action per user and local date", async () => {
    const { snapshot, user } = await createPublishedSnapshot();
    const localDate = new Date("2026-07-10T00:00:00.000Z");
    await database.actionAssignment.create({
      data: {
        userId: user.id,
        recommendationSnapshotId: snapshot.id,
        localDate,
        difficulty: "standard",
        status: "active",
        isPrimary: true,
      },
    });

    await expect(
      database.actionAssignment.create({
        data: {
          userId: user.id,
          recommendationSnapshotId: snapshot.id,
          localDate,
          difficulty: "lighter",
          status: "active",
          isPrimary: true,
        },
      }),
    ).rejects.toThrow();
  });

  test("enforces global outbox idempotency", async () => {
    const idempotencyKey = "recommendation:synthetic:1";
    await database.domainOutbox.create({
      data: {
        eventType: "recommendation.published",
        aggregateId: randomUUID(),
        payload: {},
        idempotencyKey,
      },
    });

    await expect(
      database.domainOutbox.create({
        data: {
          eventType: "recommendation.published",
          aggregateId: randomUUID(),
          payload: {},
          idempotencyKey,
        },
      }),
    ).rejects.toThrow();
  });

  test("keeps recommendation snapshots immutable", async () => {
    const { snapshot } = await createPublishedSnapshot();

    await expect(
      database.recommendationSnapshot.update({
        where: { id: snapshot.id },
        data: { actionCode: "mutated_action" },
      }),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  test("records corrections as a higher revision in the same run", async () => {
    const { run, snapshot } = await createPublishedSnapshot();

    const correction = await database.recommendationSnapshot.create({
      data: {
        runId: run.id,
        revision: 2,
        riskArea: "sleep",
        safetyClass: "normal",
        actionCode: "sleep_consistency_lighter",
        renderedPayloadJson: {},
        canonicalRuleInputJson: { lab_observation_ids: [] },
        provenanceJson: { synthetic: true },
        reviewStatus: "published",
        supersedesId: snapshot.id,
      },
    });

    expect(correction.revision).toBe(2);
    expect(correction.supersedesId).toBe(snapshot.id);
  });

  test("allows append-only deletion only inside the privacy-delete transaction", async () => {
    const { user } = await createPublishedSnapshot();

    await expect(database.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /append-only/i,
    );

    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SET LOCAL healthos.allow_privacy_delete = 'on'",
      );
      await transaction.user.delete({ where: { id: user.id } });
    });

    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
  });

  test("rejects publication when canonical inputs reference unconfirmed labs", async () => {
    const { run, user } = await createRecommendationRun();
    const document = await database.labDocument.create({
      data: {
        userId: user.id,
        objectKey: "synthetic/lab.pdf",
        sha256: "sha256:synthetic-lab",
        status: "completed",
      },
    });
    const observation = await database.labObservation.create({
      data: {
        documentId: document.id,
        code: "LDL_C",
        value: "3.1",
        unit: "mmol/L",
        evidenceBox: {},
        confidence: 0.99,
        confirmationStatus: "needs_confirmation",
      },
    });

    await expect(
      database.recommendationSnapshot.create({
        data: {
          runId: run.id,
          revision: 1,
          riskArea: "metabolic",
          safetyClass: "caution",
          actionCode: "meal_balance",
          renderedPayloadJson: {},
          canonicalRuleInputJson: { lab_observation_ids: [observation.id] },
          provenanceJson: {},
          reviewStatus: "published",
        },
      }),
    ).rejects.toThrow(/unconfirmed lab/i);
  });

  test("keeps channel lookup hashes unique within a tenant", async () => {
    const userA = await database.user.create({ data: {} });
    const userB = await database.user.create({ data: {} });
    const lookup = "hmac:synthetic-user";
    await database.channelAccount.create({
      data: {
        userId: userA.id,
        channel: "wecom",
        tenantId: "synthetic-tenant",
        externalIdLookupHmac: lookup,
        externalIdEncrypted: "ciphertext-a",
        status: "linked",
      },
    });

    await expect(
      database.channelAccount.create({
        data: {
          userId: userB.id,
          channel: "wecom",
          tenantId: "synthetic-tenant",
          externalIdLookupHmac: lookup,
          externalIdEncrypted: "ciphertext-b",
          status: "linked",
        },
      }),
    ).rejects.toThrow();
  });

  test("rolls back the recommendation when its outbox write fails", async () => {
    const { run } = await createRecommendationRun();
    const idempotencyKey = "publish:atomicity-test";
    await database.domainOutbox.create({
      data: {
        eventType: "existing.event",
        aggregateId: randomUUID(),
        payload: {},
        idempotencyKey,
      },
    });

    await expect(
      publication.publish({
        runId: run.id,
        idempotencyKey,
        riskArea: "sleep",
        safetyClass: "normal",
        actionCode: "sleep_consistency",
        renderedPayload: {},
        canonicalRuleInput: { lab_observation_ids: [] },
        provenance: { synthetic: true },
      }),
    ).rejects.toThrow();

    expect(
      await database.recommendationSnapshot.count({ where: { runId: run.id } }),
    ).toBe(0);
  });

  test("readiness reports the real database separately", async () => {
    let app: INestApplication | undefined;
    try {
      app = await createApp();
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/health/ready",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "not_ready",
        dependencies: {
          database: { status: "ok" },
          object_storage: { status: "not_configured" },
          worker_lease: { status: "not_configured" },
        },
      });
    } finally {
      await app?.close();
    }
  });
});
