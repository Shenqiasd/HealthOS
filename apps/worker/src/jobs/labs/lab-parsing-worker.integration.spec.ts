import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, before } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  FailClosedLabParserProvider,
  type LabParseRequest,
  type LabParseResult,
  LabParserProvider,
} from "./lab-parser-provider";
import { LabParsingWorker, prepareLabObservations } from "./lab-parsing-worker";

class ControlledParser extends LabParserProvider {
  result: LabParseResult = { observations: [] };
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

  async parse(request: LabParseRequest): Promise<LabParseResult> {
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

const database = new PrismaClient();
const parser = new ControlledParser();

before(async () => database.$connect());
after(async () => database.$disconnect());
afterEach(async () => {
  parser.calls = 0;
  parser.result = { observations: [] };
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions,
      safety_control_mutations, safety_control_audit_consumptions
    RESTART IDENTITY CASCADE
  `);
});

async function readyDocument() {
  await database.privacyReconciliation.upsert({
    where: { id: "global" },
    create: { id: "global", status: "ready" },
    update: { status: "ready", errorCode: null },
  });
  const user = await database.user.create({ data: { consentEpoch: 1 } });
  await database.consentRecord.create({ data: {
    userId: user.id, consentType: "health_processing", documentVersion: "synthetic-labs-v1",
    granted: true, epoch: 1, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
  } });
  const document = await database.labDocument.create({ data: {
    userId: user.id, objectKey: `synthetic-labs/${randomUUID()}`, sha256: "a".repeat(64),
    mimeType: "application/pdf", sizeBytes: 4096n, consentEpoch: 1,
    idempotencyKey: randomUUID(), requestHash: "b".repeat(64), status: "active", finalizedAt: new Date(),
  } });
  const outbox = await database.domainOutbox.create({ data: {
    eventType: "lab.document.ready", aggregateId: document.id, userId: user.id,
    idempotencyKey: `lab.document.ready:${document.id}`, payload: { document_id: document.id },
    consentRequirements: { create: { purpose: "health_processing", grantEpoch: 1 } },
  } });
  return { user, document, outbox };
}

async function run(outboxId: string, provider: LabParserProvider = parser, timeoutMilliseconds = 1_000) {
  const worker = new LabParsingWorker(database, provider, { leaseSeconds: 30, timeoutMilliseconds });
  const lease = await worker.claim(outboxId);
  await worker.process(outboxId, lease.leaseToken ?? "missing");
}

test("abstains from non-decimal numeric syntax instead of coercing it", () => {
  const rows = prepareLabObservations([
    { code: "ALT", value: " ", unit: "U/L", confidence: 1, page: 1, evidenceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.04 } },
    { code: "AST", value: "0x10", unit: "U/L", confidence: 1, page: 1, evidenceBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 } },
  ]);
  assert.ok(rows.every((row) => row.normalizedValue === null));
  assert.ok(rows.every((row) => row.dispositionCode === "unsupported_field_or_unit"));
});

test("normalizes only allowlisted fields, preserves evidence, and abstains before confirmation", async () => {
  const fixture = await readyDocument();
  parser.result = { observations: [
    { code: "ALT", value: "25", unit: "U/L", confidence: 0.995, page: 1, evidenceBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 } },
    { code: "URIC_ACID", value: "7.1", unit: "mg/dL", confidence: 0.7, page: 2, evidenceBox: { x: 0.2, y: 0.3, width: 0.2, height: 0.04 } },
    { code: "UNSUPPORTED_MARKER", value: "9", unit: "mystery", confidence: 1, page: 3, evidenceBox: { x: 0.3, y: 0.4, width: 0.2, height: 0.04 } },
  ] };
  await run(fixture.outbox.id);

  const rows = await database.labObservation.findMany({ orderBy: { page: "asc" } });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.confirmationStatus), ["needs_confirmation", "needs_confirmation", "needs_confirmation"]);
  assert.equal(Number(rows[0]?.normalizedValue), 25);
  assert.equal(rows[0]?.normalizedUnit, "U/L");
  assert.equal(Number(rows[1]?.normalizedValue).toFixed(3), "422.308");
  assert.equal(rows[1]?.dispositionCode, "low_confidence");
  assert.equal(rows[2]?.normalizedValue, null);
  assert.equal(rows[2]?.dispositionCode, "unsupported_field_or_unit");
  assert.deepEqual(rows[0]?.evidenceBox, { x: 0.1, y: 0.2, width: 0.2, height: 0.04 });
  assert.equal(await database.profileEvent.count(), 0);
});

test("keeps conflicting duplicate fields unusable", async () => {
  const fixture = await readyDocument();
  parser.result = { observations: [
    { code: "ALT", value: "25", unit: "U/L", confidence: 1, page: 1, evidenceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.04 } },
    { code: "ALT", value: "40", unit: "U/L", confidence: 1, page: 2, evidenceBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 } },
  ] };
  await run(fixture.outbox.id);
  const rows = await database.labObservation.findMany();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.dispositionCode === "conflicting_field"));
  assert.ok(rows.every((row) => row.normalizedValue === null));
  assert.equal(await database.profileEvent.count(), 0);
});

test("suppresses results when deletion or consent changes while parsing", async () => {
  for (const boundary of ["deletion", "consent"] as const) {
    const fixture = await readyDocument();
    parser.result = { observations: [
      { code: "ALT", value: "25", unit: "U/L", confidence: 1, page: 1, evidenceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.04 } },
    ] };
    const pause = parser.pauseNext();
    const running = run(fixture.outbox.id);
    await pause.entered;
    if (boundary === "deletion") {
      await database.user.update({ where: { id: fixture.user.id }, data: { status: "deleting", deletedAt: new Date() } });
      await database.labDocument.update({ where: { id: fixture.document.id }, data: { status: "deleted", deletedAt: new Date() } });
    } else {
      await database.user.update({ where: { id: fixture.user.id }, data: { consentEpoch: 2 } });
      await database.consentRecord.create({ data: {
        userId: fixture.user.id, consentType: "health_processing", documentVersion: "synthetic-labs-v2",
        granted: false, epoch: 2, correlationId: randomUUID(), requestHash: randomUUID(), source: "synthetic",
      } });
    }
    pause.release();
    await running;
    assert.equal(await database.labObservation.count(), 0);
    assert.equal(await database.profileEvent.count(), 0);
    assert.equal((await database.domainOutbox.findUniqueOrThrow({ where: { id: fixture.outbox.id } })).status, "suppressed");
    await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  }
});

test("fails closed on provider timeout, malformed evidence, and unconfigured mode", async () => {
  const timed = await readyDocument();
  const pause = parser.pauseNext();
  const running = run(timed.outbox.id, parser, 5);
  await pause.entered;
  await running;
  pause.release();
  assert.equal((await database.labDocument.findUniqueOrThrow({ where: { id: timed.document.id } })).failureCode, "parser_timeout");
  assert.equal(await database.labObservation.count(), 0);

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  const malformed = await readyDocument();
  parser.result = { observations: [
    { code: "ALT", value: "25", unit: "U/L", confidence: 1, page: 0, evidenceBox: { x: -1, y: 0, width: 2, height: 0 } },
  ] };
  await run(malformed.outbox.id);
  assert.equal((await database.labDocument.findUniqueOrThrow({ where: { id: malformed.document.id } })).failureCode, "provider_output_invalid");
  assert.equal(await database.labObservation.count(), 0);

  await database.$executeRawUnsafe(`TRUNCATE TABLE users, admin_actors, audit_logs, privacy_reconciliation, safety_control_revisions, safety_control_mutations, safety_control_audit_consumptions RESTART IDENTITY CASCADE`);
  const disabled = await readyDocument();
  await run(disabled.outbox.id, new FailClosedLabParserProvider());
  assert.equal((await database.labDocument.findUniqueOrThrow({ where: { id: disabled.document.id } })).failureCode, "provider_unconfigured");
  assert.equal(await database.labObservation.count(), 0);
});
