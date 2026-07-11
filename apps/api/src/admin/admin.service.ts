import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AdminQueueSnapshot, Prisma, RecordStatus, ReviewTask } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";
import { AdminCursorCodec, type AdminQueueCursor } from "./admin-cursor.codec";
import type { AdminPrincipal, AdminRole } from "./admin-principal";
import { canAccessSubject, hasAdminRole } from "./admin-principal";
import { reviewTaskView, safetyIncidentView } from "./admin-view";

interface WorkflowInput {
  action: "claim" | "reassign" | "release" | "acknowledge" | "resolve" | "reopen";
  expectedVersion: number;
  reason: string;
  assigneeId?: string;
  correlationId: string;
}

function auditSnapshot(row: { status: RecordStatus; assigneeId: string | null; version: number }) {
  return { status: row.status, assignee_id: row.assigneeId, version: row.version };
}

function requireCorrelationId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException("Valid correlation identifier is required");
  }
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminCursorCodec) private readonly cursors: AdminCursorCodec,
  ) {}

  async reviewTasks(principal: AdminPrincipal, input: { limit: number; cursor?: string; status?: string }) {
    const statusFilter = input.status ?? "open";
    if (input.cursor) return this.reviewSnapshotPage(principal, input.limit, statusFilter, input.cursor);
    const global = hasAdminRole(principal, ["operator", "admin"]);
    const { rows, snapshot } = await this.database.$transaction(async (tx) => {
      const rows = await tx.reviewTask.findMany({
        where: {
          taskType: { not: "safety_incident" },
          userId: global ? { not: null } : { in: principal.subjectUserIds },
          ...(input.status ? { status: input.status as RecordStatus } : { status: { in: ["pending", "active"] } }),
        },
        orderBy: [{ slaAt: "asc" }, { id: "asc" }],
        take: 1001,
      });
      const snapshot = rows.length > input.limit
        ? await this.materializeSnapshot(tx, principal, "review", statusFilter, rows)
        : null;
      return { rows, snapshot };
    }, { isolationLevel: "RepeatableRead" });
    this.assertQueueBound(rows.length);
    const page = rows.slice(0, input.limit);
    const labels = await this.assigneeLabels(page.map((row) => row.assigneeId));
    return {
      items: page.map((row) => reviewTaskView(row, row.assigneeId ? labels.get(row.assigneeId) ?? null : null)),
      next_cursor: snapshot ? this.snapshotCursor(snapshot, input.limit) : null,
    };
  }

  async safetyIncidents(principal: AdminPrincipal, input: { limit: number; cursor?: string; status?: string }) {
    this.requireRoles(principal, ["operator", "admin"]);
    const statusFilter = input.status ?? "open";
    if (input.cursor) return this.safetySnapshotPage(principal, input.limit, statusFilter, input.cursor);
    const { rows, snapshot } = await this.database.$transaction(async (tx) => {
      const rows = await tx.reviewTask.findMany({
        where: {
          taskType: "safety_incident",
          userId: { not: null },
          ...(input.status ? { status: input.status as RecordStatus } : { status: { in: ["pending", "active"] } }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1001,
      });
      const snapshot = rows.length > input.limit
        ? await this.materializeSnapshot(tx, principal, "safety", statusFilter, rows)
        : null;
      return { rows, snapshot };
    }, { isolationLevel: "RepeatableRead" });
    this.assertQueueBound(rows.length);
    const page = rows.slice(0, input.limit);
    return {
      items: await this.safetyViews(page),
      next_cursor: snapshot ? this.snapshotCursor(snapshot, input.limit) : null,
    };
  }

  async mutateReviewTask(principal: AdminPrincipal, taskId: string, input: WorkflowInput) {
    if (!["claim", "reassign", "release"].includes(input.action)) {
      throw new BadRequestException("Unsupported review-task action");
    }
    requireCorrelationId(input.correlationId);
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "review_tasks" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
      const current = await tx.reviewTask.findUnique({ where: { id: taskId } });
      if (!current || !canAccessSubject(principal, current.userId)) throw new NotFoundException("Review task not found");
      if (current.version !== input.expectedVersion) throw new ConflictException("Review task version is stale");
      const next = await this.nextReviewState(tx, principal, current, input);
      const updated = await this.auditedUpdate(tx, principal, "review_task", current.id, current, next, input);
      const label = updated.assigneeId
        ? (await tx.adminActor.findUnique({ where: { id: updated.assigneeId }, select: { displayLabel: true } }))?.displayLabel ?? null
        : null;
      return reviewTaskView(updated as ReviewTask, label);
    });
  }

  async mutateSafetyIncident(principal: AdminPrincipal, incidentId: string, input: WorkflowInput) {
    this.requireRoles(principal, ["operator", "admin"]);
    if (!["acknowledge", "resolve", "reopen"].includes(input.action)) {
      throw new BadRequestException("Unsupported safety-incident action");
    }
    requireCorrelationId(input.correlationId);
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "review_tasks"
        WHERE "task_type" = 'safety_incident' AND "subject_id" = ${incidentId}::uuid
        FOR UPDATE
      `;
      const current = await tx.reviewTask.findFirst({ where: { taskType: "safety_incident", subjectId: incidentId } });
      if (!current || !canAccessSubject(principal, current.userId)) throw new NotFoundException("Safety incident not found");
      if (current.version !== input.expectedVersion) throw new ConflictException("Safety incident version is stale");
      const transitions = {
        acknowledge: { from: "pending", to: "active" },
        resolve: { from: "active", to: "completed" },
        reopen: { from: "completed", to: "active" },
      } as const;
      const transition = transitions[input.action as keyof typeof transitions];
      if (current.status !== transition.from) throw new ConflictException("Safety incident transition is invalid");
      const next = {
        status: transition.to as RecordStatus,
        assigneeId: input.action === "resolve" ? current.assigneeId : principal.actorId,
        version: current.version + 1,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      };
      const updated = await this.auditedUpdate(tx, principal, "safety_incident", incidentId, current, next, input);
      const incident = await tx.safetyIncident.findUnique({ where: { id: incidentId } });
      if (!incident) throw new NotFoundException("Safety incident not found");
      const label = updated.assigneeId
        ? (await tx.adminActor.findUnique({ where: { id: updated.assigneeId }, select: { displayLabel: true } }))?.displayLabel ?? null
        : null;
      return safetyIncidentView(incident, updated, label);
    });
  }

  private async materializeSnapshot(
    tx: Prisma.TransactionClient,
    principal: AdminPrincipal,
    queueKind: "review" | "safety",
    statusFilter: string,
    rows: ReviewTask[],
  ): Promise<AdminQueueSnapshot> {
    this.assertQueueBound(rows.length);
    const now = new Date();
    await tx.adminQueueSnapshot.deleteMany({ where: { actorId: principal.actorId, expiresAt: { lte: now } } });
    const snapshot = await tx.adminQueueSnapshot.create({ data: {
      actorId: principal.actorId,
      queueKind,
      statusFilter,
      filterHash: this.filterHash(queueKind, statusFilter),
      authorizationHash: this.authorizationHash(principal),
      expiresAt: new Date(now.getTime() + 15 * 60_000),
    } });
    await tx.adminQueueSnapshotItem.createMany({ data: rows.map((row, position) => ({
      snapshotId: snapshot.id,
      position,
      workItemId: row.id,
      workItemVersion: row.version,
    })) });
    return snapshot;
  }

  private async reviewSnapshotPage(principal: AdminPrincipal, limit: number, statusFilter: string, value: string) {
    const { snapshot, items } = await this.loadSnapshot(principal, "review", statusFilter, value, limit);
    const page = items.slice(0, limit);
    const rows = page.map(({ workItem }) => workItem);
    const labels = await this.assigneeLabels(rows.map((row) => row.assigneeId));
    return {
      items: rows.map((row) => reviewTaskView(row, row.assigneeId ? labels.get(row.assigneeId) ?? null : null)),
      next_cursor: items.length > limit && page.length > 0
        ? this.snapshotCursor(snapshot, page.at(-1)!.position + 1)
        : null,
    };
  }

  private async safetySnapshotPage(principal: AdminPrincipal, limit: number, statusFilter: string, value: string) {
    const { snapshot, items } = await this.loadSnapshot(principal, "safety", statusFilter, value, limit);
    const page = items.slice(0, limit);
    const rows = page.map(({ workItem }) => workItem);
    return {
      items: await this.safetyViews(rows),
      next_cursor: items.length > limit && page.length > 0
        ? this.snapshotCursor(snapshot, page.at(-1)!.position + 1)
        : null,
    };
  }

  private async loadSnapshot(
    principal: AdminPrincipal,
    queueKind: "review" | "safety",
    statusFilter: string,
    value: string,
    limit: number,
  ) {
    const cursor = this.cursors.decode(value);
    if (
      cursor.actor_id !== principal.actorId || cursor.queue_kind !== queueKind
      || cursor.status_filter !== statusFilter || Date.parse(cursor.expires_at) <= Date.now()
    ) throw new BadRequestException("Queue cursor does not match this request");
    const snapshot = await this.database.adminQueueSnapshot.findUnique({ where: { id: cursor.snapshot_id } });
    if (
      !snapshot || snapshot.actorId !== principal.actorId || snapshot.queueKind !== queueKind
      || snapshot.statusFilter !== statusFilter || snapshot.expiresAt <= new Date()
      || snapshot.expiresAt.toISOString() !== cursor.expires_at
      || snapshot.filterHash !== this.filterHash(queueKind, statusFilter)
      || snapshot.authorizationHash !== this.authorizationHash(principal)
    ) throw new BadRequestException("Queue snapshot is unavailable or expired");
    const items = await this.database.adminQueueSnapshotItem.findMany({
      where: { snapshotId: snapshot.id, position: { gte: cursor.next_position } },
      include: { workItem: true },
      orderBy: { position: "asc" },
      take: limit + 1,
    });
    return { cursor, snapshot, items };
  }

  private async safetyViews(rows: ReviewTask[]) {
    const incidents = await this.database.safetyIncident.findMany({
      where: { id: { in: rows.map((row) => row.subjectId) }, severity: { in: ["low", "medium", "high", "critical"] } },
    });
    const incidentById = new Map(incidents.map((incident) => [incident.id, incident]));
    const labels = await this.assigneeLabels(rows.map((row) => row.assigneeId));
    return rows.flatMap((row) => {
      const incident = incidentById.get(row.subjectId);
      return incident
        ? [safetyIncidentView(incident, row, row.assigneeId ? labels.get(row.assigneeId) ?? null : null)]
        : [];
    });
  }

  private snapshotCursor(snapshot: AdminQueueSnapshot, nextPosition: number): string {
    const cursor: AdminQueueCursor = {
      snapshot_id: snapshot.id,
      next_position: nextPosition,
      actor_id: snapshot.actorId,
      queue_kind: snapshot.queueKind as "review" | "safety",
      status_filter: snapshot.statusFilter,
      expires_at: snapshot.expiresAt.toISOString(),
    };
    return this.cursors.encode(cursor);
  }

  private filterHash(queueKind: "review" | "safety", statusFilter: string): string {
    return createHash("sha256").update(JSON.stringify({ queue_kind: queueKind, status_filter: statusFilter })).digest("hex");
  }

  private authorizationHash(principal: AdminPrincipal): string {
    return createHash("sha256").update(JSON.stringify({
      roles: [...principal.roles].sort(),
      subject_user_ids: [...principal.subjectUserIds].sort(),
    })).digest("hex");
  }

  private assertQueueBound(size: number): void {
    if (size > 1000) throw new ConflictException("Operations queue exceeds the snapshot bound; narrow the filter");
  }

  private async nextReviewState(
    tx: Prisma.TransactionClient,
    principal: AdminPrincipal,
    current: ReviewTask,
    input: WorkflowInput,
  ) {
    if (input.action === "claim") {
      this.requireRoles(principal, ["reviewer", "medical_approver", "operator", "admin"]);
      if (current.status !== "pending" || current.assigneeId) throw new ConflictException("Review task is not claimable");
      return { status: "active" as RecordStatus, assigneeId: principal.actorId, version: current.version + 1, updatedAt: this.nextTime(current.updatedAt) };
    }
    if (input.action === "release") {
      if (current.status !== "active" || !current.assigneeId) throw new ConflictException("Review task is not releasable");
      if (current.assigneeId !== principal.actorId && !hasAdminRole(principal, ["operator", "admin"])) {
        throw new ForbiddenException("Only the assignee or operations role can release this task");
      }
      return { status: "pending" as RecordStatus, assigneeId: null, version: current.version + 1, updatedAt: this.nextTime(current.updatedAt) };
    }
    this.requireRoles(principal, ["operator", "admin"]);
    if (current.status !== "active" || !input.assigneeId) throw new ConflictException("Active task and backup assignee are required");
    const target = await tx.adminActor.findUnique({
      where: { id: input.assigneeId }, include: { roles: true, subjectScopes: true },
    });
    if (
      !target || target.status !== "active"
      || !target.roles.some(({ role }) => ["reviewer", "medical_approver", "operator", "admin"].includes(role))
      || (!target.roles.some(({ role }) => ["operator", "admin"].includes(role))
        && (!current.userId || !target.subjectScopes.some(({ userId }) => userId === current.userId)))
    ) throw new ConflictException("Backup assignee is not eligible for this subject");
    return { status: "active" as RecordStatus, assigneeId: target.id, version: current.version + 1, updatedAt: this.nextTime(current.updatedAt) };
  }

  private async auditedUpdate(
    tx: Prisma.TransactionClient,
    principal: AdminPrincipal,
    resourceType: "review_task" | "safety_incident",
    resourceId: string,
    current: ReviewTask,
    next: { status: RecordStatus; assigneeId: string | null; version: number; updatedAt: Date },
    input: WorkflowInput,
  ): Promise<ReviewTask> {
    const role = this.auditRole(principal, resourceType);
    const before = auditSnapshot(current);
    const after = auditSnapshot(next);
    const [hashes] = await tx.$queryRaw<Array<{ before_hash: string; after_hash: string }>>`
      SELECT
        encode(digest(${JSON.stringify(before)}::jsonb::text, 'sha256'), 'hex') AS "before_hash",
        encode(digest(${JSON.stringify(after)}::jsonb::text, 'sha256'), 'hex') AS "after_hash"
    `;
    if (!hashes) throw new ConflictException("Audit hashing failed");
    const audit = await tx.auditLog.create({ data: {
      adminActorId: principal.actorId,
      actorRole: role,
      action: `operations.${resourceType}.${input.action}`,
      resourceType,
      resourceId,
      reason: input.reason.trim(),
      correlationId: input.correlationId,
      beforeJson: before,
      afterJson: after,
      beforeHash: hashes.before_hash,
      afterHash: hashes.after_hash,
      operationVersion: next.version,
    } });
    await tx.$executeRaw`SELECT set_config('healthos.operations_audit_id', ${audit.id}, true)`;
    return tx.reviewTask.update({ where: { id: current.id }, data: next });
  }

  private auditRole(principal: AdminPrincipal, resourceType: "review_task" | "safety_incident"): AdminRole {
    const order: AdminRole[] = resourceType === "safety_incident"
      ? ["admin", "operator"]
      : ["admin", "operator", "medical_approver", "reviewer"];
    const role = order.find((candidate) => principal.roles.includes(candidate));
    if (!role) throw new ForbiddenException("Administrator role is not permitted");
    return role;
  }

  private requireRoles(principal: AdminPrincipal, roles: readonly AdminRole[]): void {
    if (!hasAdminRole(principal, roles)) throw new ForbiddenException("Administrator role is not permitted");
  }

  private async assigneeLabels(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const actors = await this.database.adminActor.findMany({ where: { id: { in: unique } }, select: { id: true, displayLabel: true } });
    return new Map(actors.map((actor) => [actor.id, actor.displayLabel]));
  }

  private nextTime(previous: Date): Date {
    return new Date(Math.max(Date.now(), previous.getTime() + 1));
  }
}
