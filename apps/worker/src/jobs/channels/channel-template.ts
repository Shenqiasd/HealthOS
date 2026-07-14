export type ScheduleNotificationKind =
  | "daily_advisor"
  | "behavior_reminder"
  | "weekly_review";

export type ChannelTemplatePayload = {
  schema_version: 1;
  template: "daily_advisor_v1" | "behavior_reminder_v1" | "weekly_review_v1";
  copy_key:
    | "notification.daily_advisor"
    | "notification.behavior_reminder"
    | "notification.weekly_review";
  action_key: "open_today" | "open_review";
  deeplink_path: "/today" | "/review";
};

const TEMPLATES: Readonly<Record<ScheduleNotificationKind, ChannelTemplatePayload>> = {
  daily_advisor: {
    schema_version: 1,
    template: "daily_advisor_v1",
    copy_key: "notification.daily_advisor",
    action_key: "open_today",
    deeplink_path: "/today",
  },
  behavior_reminder: {
    schema_version: 1,
    template: "behavior_reminder_v1",
    copy_key: "notification.behavior_reminder",
    action_key: "open_today",
    deeplink_path: "/today",
  },
  weekly_review: {
    schema_version: 1,
    template: "weekly_review_v1",
    copy_key: "notification.weekly_review",
    action_key: "open_review",
    deeplink_path: "/review",
  },
};

export function renderChannelTemplate(
  kind: ScheduleNotificationKind,
  path: string,
): ChannelTemplatePayload {
  const template = TEMPLATES[kind];
  if (!template) throw new Error("Notification template is not allowlisted");
  if (path !== template.deeplink_path) {
    throw new Error("Notification path is not allowlisted");
  }
  return { ...template };
}

export function parseChannelTemplate(value: unknown): ChannelTemplatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification payload must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = ["action_key", "copy_key", "deeplink_path", "schema_version", "template"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Notification payload contains non-allowlisted fields");
  }
  const matched = Object.values(TEMPLATES).find((template) =>
    template.schema_version === candidate.schema_version &&
    template.template === candidate.template &&
    template.copy_key === candidate.copy_key &&
    template.action_key === candidate.action_key &&
    template.deeplink_path === candidate.deeplink_path);
  if (!matched) throw new Error("Notification payload is not allowlisted");
  return { ...matched };
}
