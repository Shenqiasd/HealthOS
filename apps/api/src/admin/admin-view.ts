import type { ReviewTask, SafetyIncident } from "@prisma/client";

export function reviewTaskView(task: ReviewTask, assigneeLabel: string | null) {
  return {
    id: task.id,
    task_type: task.taskType,
    priority: task.priority,
    status: task.status,
    assignee_id: task.assigneeId,
    assignee_label: assigneeLabel,
    sla_at: task.slaAt.toISOString(),
    version: task.version,
  };
}

export function safetyIncidentView(incident: SafetyIncident, task: ReviewTask, assigneeLabel: string | null) {
  const source = incident.source.startsWith("rule:")
    ? "rule"
    : incident.source.startsWith("provider:")
      ? "provider"
      : incident.source.startsWith("channel:")
        ? "channel"
        : incident.source.startsWith("system:")
          ? "system"
          : "other";
  return {
    id: incident.id,
    source,
    severity: incident.severity,
    status: task.status,
    assignee_id: task.assigneeId,
    assignee_label: assigneeLabel,
    created_at: incident.createdAt.toISOString(),
    version: task.version,
  };
}
