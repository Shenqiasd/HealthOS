import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, before } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  FailClosedFoodVisionProvider,
  type FoodVisionRequest,
  type FoodVisionResult,
  FoodVisionProvider,
} from "./food-vision-provider";
import { FoodRiskWorker, prepareFoodRiskResult } from "./food-risk-worker";

class ControlledVisionProvider extends FoodVisionProvider {
  result: FoodVisionResult = {
    mealPresence: "no_food",
    mealCompleteness: "complete",
    overallConfidence: 1,
    dishes: [],
    labels: [],
  };
  calls = 0;
  private entered: (() => void) | null = null;
  private wait: Promise<void> | null = null;

  pauseNext(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    this.wait = new Promise<void>((resolve) => { release = resolve; });
    this.entered = entered;
    return { entered: enteredPromise, release };
  }

  async analyze(request: FoodVisionRequest): Promise<FoodVisionResult> {
    void request;
    this.calls += 1;
    this.entered?.();
    this.entered = null;
    if (this.wait) {
      const wait = this.wait;
      this.wait = null;
      await wait;
    }
    return this.result;
  }
}

const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
const database = new PrismaClient();
const provider = new ControlledVisionProvider();

before(async () => database.$connect());
after(async () => database.$disconnect());
afterEach(async () => {
  provider.calls = 0;
  provider.result = {
    mealPresence: "no_food",
    mealCompleteness: "complete",
    overallConfidence: 1,
    dishes: [],
    labels: [],
  };
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions,
      safety_control_mutations, safety_control_audit_consumptions
    RESTART IDENTITY CASCADE
  `);
});

async function readyScan() {
  await database.privacyReconciliation.upsert({
    where: { id: "global" },
    create: { id: "global", status: "ready" },
    update: { status: "ready", errorCode: null },
  });
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
  const scan = await database.foodScan.create({ data: {
    userId: user.id,
    objectKey: `synthetic-food/${randomUUID()}`,
    capturedAt: new Date("2026-07-14T04:00:00.000Z"),
    modelVersion: "pending",
    overallConfidence: 0,
    consentEpoch: 1,
    status: "active",
  } });
  const outbox = await database.domainOutbox.create({ data: {
    eventType: "food.scan.ready",
    aggregateId: scan.id,
    userId: user.id,
    idempotencyKey: `food.scan.ready:${scan.id}`,
    payload: { scan_id: scan.id },
    consentRequirements: { create: { purpose: "health_processing", grantEpoch: 1 } },
  } });
  return { user, scan, outbox };
}

async function run(outboxId: string, vision: FoodVisionProvider = provider, timeoutMilliseconds = 1_000) {
  const worker = new FoodRiskWorker(database, vision, { leaseSeconds: 30, timeoutMilliseconds });
  const lease = await worker.claim(outboxId);
  await worker.process(outboxId, lease.leaseToken ?? "missing");
}

test("keeps only allowlisted qualitative candidates and confidence-gates uncertain labels", () => {
  const prepared = prepareFoodRiskResult({
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.96,
    dishes: [
      { code: "red_braised_pork", confidence: 0.96, evidenceBox: box },
      { code: "white_rice", confidence: 0.98, evidenceBox: box },
      { code: "milk_tea", confidence: 0.99, evidenceBox: box },
    ],
    labels: [
      { label: "sugary_drink", level: "high", confidence: 0.99, evidenceBox: box },
      { label: "high_oil", level: "medium", confidence: 0.94, evidenceBox: box },
      { label: "high_purine", level: "unknown", confidence: 0.55, evidenceBox: box },
    ],
  });
  assert.equal(prepared.dispositionCode, "visible");
  assert.deepEqual(prepared.dishes.map((item) => item.code), ["red_braised_pork", "white_rice", "milk_tea"]);
  assert.deepEqual(prepared.labels.map((item) => [item.label, item.dispositionCode]), [
    ["sugary_drink", "visible"],
    ["high_oil", "visible"],
    ["high_purine", "abstained"],
  ]);
  assert.doesNotMatch(JSON.stringify(prepared), /kcal|calorie|protein|carbs|fat|macro|diagnos|retrain/i);
});

test("abstains for no-food, cropped, unsupported, and low-confidence images", () => {
  const cases: Array<[FoodVisionResult, string]> = [
    [{ mealPresence: "no_food", mealCompleteness: "complete", overallConfidence: 1, dishes: [], labels: [] }, "no_food"],
    [{
      mealPresence: "food",
      mealCompleteness: "cropped",
      overallConfidence: 0.95,
      dishes: [{ code: "fried_dish", confidence: 0.95, evidenceBox: box }],
      labels: [{ label: "high_oil", level: "high", confidence: 0.95, evidenceBox: box }],
    }, "needs_confirmation"],
    [{ mealPresence: "uncertain", mealCompleteness: "unsupported", overallConfidence: 0, dishes: [], labels: [] }, "unsupported"],
    [{
      mealPresence: "food",
      mealCompleteness: "complete",
      overallConfidence: 0.6,
      dishes: [{ code: "ambiguous_beverage", confidence: 0.6, evidenceBox: box }],
      labels: [{ label: "alcohol", level: "unknown", confidence: 0.5, evidenceBox: box }],
    }, "needs_confirmation"],
  ];
  for (const [input, disposition] of cases) {
    const prepared = prepareFoodRiskResult(input);
    assert.equal(prepared.dispositionCode, disposition);
    assert.equal(prepared.labels.filter((item) => item.dispositionCode === "visible").length, 0);
  }
});

test("persists evidence-bound labels without publishing profile or recommendation input", async () => {
  const fixture = await readyScan();
  provider.result = {
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.97,
    dishes: [{ code: "milk_tea", confidence: 0.99, evidenceBox: box }],
    labels: [{ label: "sugary_drink", level: "high", confidence: 0.99, evidenceBox: box }],
  };
  await run(fixture.outbox.id);
  const scan = await database.foodScan.findUniqueOrThrow({ where: { id: fixture.scan.id } });
  const labels = await database.foodRiskLabel.findMany({ where: { foodScanId: fixture.scan.id } });
  const candidates = await database.$queryRaw<Array<{ code: string; disposition_code: string }>>`
    SELECT "code", "disposition_code" FROM "food_dish_candidates" WHERE "food_scan_id" = ${fixture.scan.id}::uuid
  `;
  assert.equal(scan.status, "completed");
  assert.equal(labels.length, 1);
  assert.equal(labels[0]?.label, "sugary_drink");
  assert.deepEqual(candidates, [{ code: "milk_tea", disposition_code: "visible" }]);
  assert.equal(await database.profileEvent.count({ where: { userId: fixture.user.id } }), 0);
  assert.equal(await database.recommendationRun.count({ where: { userId: fixture.user.id } }), 0);
});

test("applies each qualitative label kill switch independently", async () => {
  const fixture = await readyScan();
  const actor = await database.adminActor.create({ data: {
    lookupHash: "a".repeat(64),
    displayLabel: "Synthetic Food Operator",
  } });
  await database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.safetyControlRevision.create({ data: {
      controlType: "kill_switch",
      controlKey: "food.label.sugary_drink",
      scopeType: "global",
      scopeId: "*",
      active: true,
      version: 1,
      reason: "synthetic_test",
      adminActorId: actor.id,
      correlationId: randomUUID(),
    } });
  });
  provider.result = {
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.99,
    dishes: [{ code: "milk_tea", confidence: 0.99, evidenceBox: box }],
    labels: [
      { label: "sugary_drink", level: "high", confidence: 0.99, evidenceBox: box },
      { label: "high_oil", level: "medium", confidence: 0.95, evidenceBox: box },
    ],
  };
  await run(fixture.outbox.id);
  const labels = await database.foodRiskLabel.findMany({ where: { foodScanId: fixture.scan.id } });
  assert.deepEqual(labels.map((item) => item.label), ["high_oil"]);
  assert.equal((await database.foodScan.findUniqueOrThrow({ where: { id: fixture.scan.id } })).dispositionCode, "visible");
});

test("suppresses leased work when deletion or consent changes during analysis", async () => {
  for (const boundary of ["deletion", "consent"] as const) {
    const fixture = await readyScan();
    provider.result = {
      mealPresence: "food",
      mealCompleteness: "complete",
      overallConfidence: 0.99,
      dishes: [{ code: "milk_tea", confidence: 0.99, evidenceBox: box }],
      labels: [{ label: "sugary_drink", level: "high", confidence: 0.99, evidenceBox: box }],
    };
    const pause = provider.pauseNext();
    const running = run(fixture.outbox.id);
    await pause.entered;
    if (boundary === "deletion") {
      await database.user.update({ where: { id: fixture.user.id }, data: { status: "deleting", deletedAt: new Date() } });
    } else {
      await database.user.update({ where: { id: fixture.user.id }, data: { consentEpoch: 2 } });
      await database.consentRecord.create({ data: {
        userId: fixture.user.id,
        consentType: "health_processing",
        documentVersion: "synthetic-food-v2",
        granted: false,
        epoch: 2,
        correlationId: randomUUID(),
        requestHash: randomUUID(),
        source: "synthetic",
      } });
    }
    pause.release();
    await running;
    assert.equal(await database.foodRiskLabel.count({ where: { foodScanId: fixture.scan.id } }), 0);
    assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: fixture.outbox.id } })).status, "suppressed");
    await database.$executeRawUnsafe(`
      TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions,
        safety_control_mutations, safety_control_audit_consumptions
      RESTART IDENTITY CASCADE
    `);
  }
});

test("fails closed for timeout, forbidden output, unknown codes, and unconfigured provider", async () => {
  const timed = await readyScan();
  const pause = provider.pauseNext();
  const running = run(timed.outbox.id, provider, 5);
  await pause.entered;
  await running;
  pause.release();
  assert.equal((await database.foodScan.findUniqueOrThrow({ where: { id: timed.scan.id } })).failureCode, "vision_timeout");

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  const forbidden = await readyScan();
  provider.result = {
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.99,
    dishes: [{ code: "milk_tea", confidence: 0.99, evidenceBox: box }],
    labels: [],
    kcal: 500,
  } as unknown as FoodVisionResult;
  await run(forbidden.outbox.id);
  assert.equal((await database.foodScan.findUniqueOrThrow({ where: { id: forbidden.scan.id } })).failureCode, "provider_output_invalid");

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  const unknown = await readyScan();
  provider.result = {
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.99,
    dishes: [{ code: "invented_dish", confidence: 0.99, evidenceBox: box }],
    labels: [{ label: "invented_risk", level: "high", confidence: 0.99, evidenceBox: box }],
  };
  await run(unknown.outbox.id);
  assert.equal((await database.foodScan.findUniqueOrThrow({ where: { id: unknown.scan.id } })).failureCode, "provider_output_invalid");

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  const disabled = await readyScan();
  await run(disabled.outbox.id, new FailClosedFoodVisionProvider());
  assert.equal((await database.foodScan.findUniqueOrThrow({ where: { id: disabled.scan.id } })).failureCode, "provider_unconfigured");
});

test("rejects every forbidden precision, medical, and automatic-learning key family", () => {
  const valid: FoodVisionResult = {
    mealPresence: "food",
    mealCompleteness: "complete",
    overallConfidence: 0.99,
    dishes: [{ code: "white_rice", confidence: 0.99, evidenceBox: box }],
    labels: [{ label: "refined_carbohydrate", level: "medium", confidence: 0.99, evidenceBox: box }],
  };
  for (const key of [
    "calories",
    "protein",
    "carbs",
    "fat",
    "macroTotals",
    "diagnosis",
    "retrainAutomatically",
  ]) {
    assert.throws(
      () => prepareFoodRiskResult({ ...valid, [key]: 1 } as unknown as FoodVisionResult),
      /forbidden fields/,
      key,
    );
  }
});
