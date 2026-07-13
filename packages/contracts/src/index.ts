export interface DependencyHealth {
  status: "not_configured" | "ok" | "error";
}

export interface ReadinessResponse {
  status: "not_ready" | "ready";
  dependencies: {
    database: DependencyHealth;
    object_storage: DependencyHealth;
    worker_lease: DependencyHealth;
  };
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    correlation_id: string;
  };
}

export interface NonceResponse {
  nonce: string;
  expires_at: string;
}

export interface AppleAuthenticationRequest {
  identity_token: string;
  nonce: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface SessionTokensResponse {
  access_token: string;
  refresh_token: string;
}

export interface AuthenticationResponse extends SessionTokensResponse {
  user_id: string;
}

export interface LogoutResponse {
  status: "revoked";
}

export interface DeviceRegistrationRequest {
  device_id: string;
  app_version: string;
  apns_token?: string;
}

export interface DeviceRegistrationResponse {
  id: string;
  device_id: string;
  app_version: string | null;
}

export interface DeletionFence {
  user_lookup_hash: string;
  hash_key_version: string;
  deletion_job_id: string;
  status: "pending" | "completed";
  created_at: string;
  completed_at?: string;
}

export interface PrivacyControlStore {
  beginDeletionFence(fence: Omit<DeletionFence, "status" | "created_at">): Promise<DeletionFence>;
  completeDeletionFence(userLookupHash: string, deletionJobId: string): Promise<DeletionFence>;
  listCompletedDeletionFences(): Promise<ReadonlyArray<DeletionFence>>;
  blockSends(restoreRunId: string): Promise<void>;
  allowSends(restoreRunId: string): Promise<void>;
  isSendAllowed(): Promise<boolean>;
}

export interface ConsentWriteRequest {
  purpose: "privacy_terms" | "health_processing" | "notifications" | "external_ai";
  document_version: string;
  granted: boolean;
}

export interface ConsentRecordResponse extends ConsentWriteRequest {
  id: string;
  epoch: number;
  recorded_at: string;
}

export interface ConsentSettingsResponse {
  consent_epoch: number;
  purposes: Record<string, {
    granted: boolean;
    document_version: string;
    epoch: number;
    recorded_at: string;
  }>;
}

export interface PrivacyRequestBody {
  idempotency_key: string;
}

export interface ExportJobResponse {
  id: string;
  status: "requested" | "generating" | "ready" | "expired" | "failed_retryable";
  artifact_available: boolean;
  expires_at: string | null;
}

export interface DeletionRequestResponse {
  id: string;
  status: "requested" | "frozen" | "deleting" | "completed" | "failed_retryable";
  status_token: string;
}

export interface DeletionStatusResponse {
  id: string;
  status: "requested" | "frozen" | "deleting" | "completed" | "failed_retryable";
  completed_at: string | null;
}

export interface HealthSourceContributionRequest {
  source_id: string;
  kind: "phone" | "watch" | "third_party" | "user";
  contribution: number;
}

export interface DailyHealthFactRequest {
  local_date: string;
  metric: "steps" | "active_energy_kcal" | "exercise_minutes" | "sleep_minutes" |
    "resting_heart_rate_bpm" | "hrv_ms" | "workout_minutes" | "weight_kg" | "vo2_max";
  value: number;
  coverage: number;
  source_vector: HealthSourceContributionRequest[];
}

export interface HealthSyncRequest {
  idempotency_key: string;
  device_id: string;
  anchor_epoch: number;
  timezone: string;
  facts: DailyHealthFactRequest[];
}

export interface HealthSyncResponse {
  sync_run_id: string;
  server_sequence: string;
  created_revision_ids: string[];
}

export interface HealthFreshnessResponse {
  status: "absent" | "partial" | "current" | "stale";
  latest_local_date: string | null;
}

export interface ProfileCandidateResponse {
  id: string;
  candidate_type: string;
  structured_value: unknown;
  status: "pending" | "confirmed" | "rejected";
  confirmed_event_id: string | null;
}

export interface ProfileSnapshotResponse {
  version: number;
  facts: unknown;
  source_sequence: string;
  snapshot_hash: string;
}

export type TodayFreshnessStatus = "absent" | "partial" | "current" | "stale";

export type TodayState =
  | "active_action"
  | "first_launch"
  | "awaiting_recommendation"
  | "stale_data"
  | "profile_changed"
  | "recommendation_withdrawn"
  | "clinical_follow_up"
  | "action_completed"
  | "action_skipped"
  | "action_rejected"
  | "action_expired"
  | "action_replaced";

export interface TodayActionCommands {
  complete: boolean;
  lighter: boolean;
  swap: boolean;
  skip: boolean;
  why: boolean;
}

export interface TodayActionViewModel {
  id: string;
  code: string;
  version: number;
  status: "active";
  duration_minutes: number;
  difficulty: "light" | "standard";
  reason_key: string;
  signal_key: string;
  commands: TodayActionCommands;
}

export interface TodayRecoveryViewModel {
  code: Exclude<TodayState, "active_action">;
  copy_key: string;
  primary_command: "refresh" | "open_permissions" | "open_coach" | "none";
}

export interface TodayViewModel {
  schema_version: 1;
  state: TodayState;
  local_date: string;
  generated_at: string | null;
  cache_identity: string;
  correlation_id: string;
  freshness: {
    status: TodayFreshnessStatus;
    coverage: number | null;
    latest_local_date: string | null;
  };
  momo: {
    state: "ready" | "waiting" | "care" | "celebrate" | "reset";
    copy_key: string;
  };
  action: TodayActionViewModel | null;
  recovery: TodayRecoveryViewModel | null;
}

export type ActionFeedbackCommand = "complete" | "skip" | "lighter" | "swap";
export type ActionFeedbackReason = "too_hard" | "no_time" | "tired" | "uncomfortable" | "weather" | "neutral";
export type ActionFeedbackOutcome = "completed" | "skipped" | "replaced" | "no_safe_alternative";

interface ActionFeedbackRequestIdentity {
  expected_version: number;
  idempotency_key: string;
}

export type ActionFeedbackRequest = ActionFeedbackRequestIdentity & (
  | { command: "complete"; reason_code?: never }
  | { command: "skip"; reason_code: Exclude<ActionFeedbackReason, "too_hard"> }
  | { command: "lighter"; reason_code: "too_hard" }
  | { command: "swap"; reason_code?: ActionFeedbackReason }
);

export interface ActionFeedbackAssignment {
  id: string;
  code: string;
  status: "active" | "completed" | "skipped" | "replaced";
  version: number;
  difficulty: "light" | "standard";
}

export interface ActionFeedbackResponse {
  schema_version: 1;
  feedback_event_id: string;
  idempotency_key: string;
  outcome: ActionFeedbackOutcome;
  reason_code: ActionFeedbackReason | "no_safe_alternative" | null;
  original_action: ActionFeedbackAssignment;
  current_action: ActionFeedbackAssignment | null;
  recovery_key: string | null;
}

export type SignalCode = "sleep_recovery" | "fatty_liver" | "uric_acid" | "waist_weight";
export type SignalState = "stable" | "watch" | "unknown";
export type SignalTrend = "improving" | "stable" | "worsening" | "unknown";
export type SignalFreshness = "current" | "partial" | "stale" | "unknown";

export interface MapSignalSummary {
  code: SignalCode;
  state: SignalState;
  trend: SignalTrend;
  confidence: number;
  freshness: SignalFreshness;
}

export interface MapTodayActionLink {
  id: string;
  code: "SLEEP_WIND_DOWN" | "SLEEP_WIND_DOWN_LIGHT" | "POST_MEAL_WALK" | "SUGARY_DRINK_SWAP";
  version: number;
}

export interface MapSignalDetail extends MapSignalSummary {
  drivers: Array<{ code: "validated_rule_signal" }>;
  today_action_link: MapTodayActionLink | null;
}

export interface MapViewModel {
  schema_version: 1;
  local_date: string;
  generated_at: string | null;
  signals: MapSignalSummary[];
  selected: MapSignalDetail | null;
}

export type ReviewConclusionKey =
  | "review.conclusion.no_data"
  | "review.conclusion.partial_week"
  | "review.conclusion.improving"
  | "review.conclusion.mixed"
  | "review.conclusion.watch"
  | "review.conclusion.stable";

export interface ReviewEvidenceRow {
  signal_code: SignalCode;
  state: SignalState;
  trend: SignalTrend;
  freshness: SignalFreshness;
  days_observed: number;
}

export interface ReviewFrictionSummary {
  code:
    | "review.friction.no_actions"
    | "review.friction.all_skipped"
    | "review.friction.mostly_completed"
    | "review.friction.mixed";
  completed: number;
  skipped: number;
  replaced: number;
}

export interface ReviewNextAction {
  assignment_id: string;
  action_code: MapTodayActionLink["code"];
}

export interface WeeklyReviewViewModel {
  schema_version: 1;
  id: string;
  week_start: string;
  week_end: string;
  cutoff_at: string;
  revision: number;
  coverage: number;
  conclusion_key: ReviewConclusionKey;
  evidence: ReviewEvidenceRow[];
  friction: ReviewFrictionSummary;
  next_actions: ReviewNextAction[];
  generated_at: string;
}

export type ReviewShareVariant = "redacted" | "private";

interface ReviewSharePayloadBase {
  schema_version: 1;
  review_id: string;
  week_start: string;
  week_end: string;
  coverage: number;
  conclusion_key: ReviewConclusionKey;
  evidence: ReviewEvidenceRow[];
  friction: ReviewFrictionSummary;
}

export interface RedactedReviewSharePayload extends ReviewSharePayloadBase {
  variant: "redacted";
  next_actions: Array<{ action_code: MapTodayActionLink["code"] }>;
}

export interface PrivateReviewSharePayload extends ReviewSharePayloadBase {
  variant: "private";
  next_actions: ReviewNextAction[];
}

export type ReviewSharePayload = RedactedReviewSharePayload | PrivateReviewSharePayload;

export interface ReviewShareResponse {
  id: string;
  expires_at: string;
  payload: ReviewSharePayload;
}

export interface ReviewGenerationRequest {
  week_start: string;
  cutoff_at: string;
  idempotency_key: string;
}

export interface ReviewGenerationResponse {
  request_id: string;
  status: "pending" | "leased" | "sent" | "failed" | "suppressed";
}

export interface ReviewShareSource {
  id: string;
  weekStart: Date;
  coverage: number;
  conclusion: ReviewConclusionKey;
  evidence: ReviewEvidenceRow[];
  friction: ReviewFrictionSummary;
  nextActions: ReviewNextAction[];
}

export function buildWeeklyReviewSharePayload(
  snapshot: ReviewShareSource,
  variant: "redacted",
): RedactedReviewSharePayload;
export function buildWeeklyReviewSharePayload(
  snapshot: ReviewShareSource,
  variant: "private",
): PrivateReviewSharePayload;
export function buildWeeklyReviewSharePayload(
  snapshot: ReviewShareSource,
  variant: ReviewShareVariant,
): ReviewSharePayload;
export function buildWeeklyReviewSharePayload(
  snapshot: ReviewShareSource,
  variant: ReviewShareVariant,
): ReviewSharePayload {
  const weekStart = snapshot.weekStart.toISOString().slice(0, 10);
  const weekEnd = new Date(snapshot.weekStart.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  const base = {
    schema_version: 1 as const,
    review_id: snapshot.id,
    week_start: weekStart,
    week_end: weekEnd,
    coverage: snapshot.coverage,
    conclusion_key: snapshot.conclusion,
    evidence: snapshot.evidence,
    friction: snapshot.friction,
  };
  return variant === "private"
    ? { ...base, variant, next_actions: snapshot.nextActions }
    : {
      ...base,
      variant,
      next_actions: snapshot.nextActions.map((item) => ({ action_code: item.action_code })),
    };
}

export type AdminRole = "reviewer" | "operator" | "admin" | "medical_approver";
export type AdminQueueStatus = "pending" | "active" | "completed";

export interface AdminReviewTask {
  id: string;
  task_type: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: AdminQueueStatus;
  assignee_id: string | null;
  assignee_label: string | null;
  sla_at: string;
  version: number;
}

export interface AdminSafetyIncident {
  id: string;
  source: "rule" | "provider" | "channel" | "system" | "other";
  severity: "low" | "medium" | "high" | "critical";
  status: AdminQueueStatus;
  assignee_id: string | null;
  assignee_label: string | null;
  created_at: string;
  version: number;
}

export interface AdminReviewTaskPage {
  items: AdminReviewTask[];
  next_cursor: string | null;
}

export interface AdminSafetyIncidentPage {
  items: AdminSafetyIncident[];
  next_cursor: string | null;
}

interface AdminWorkflowActionRequestBase {
  expected_version: number;
  reason: string;
}

export type AdminReviewWorkflowActionRequest =
  | (AdminWorkflowActionRequestBase & { action: "claim"; assignee_id?: never })
  | (AdminWorkflowActionRequestBase & { action: "reassign"; assignee_id: string })
  | (AdminWorkflowActionRequestBase & { action: "release"; assignee_id?: never });

export type AdminSafetyWorkflowActionRequest = AdminWorkflowActionRequestBase & {
  action: "acknowledge" | "resolve" | "reopen";
  assignee_id?: never;
};

export type ReminderIntensity = "gentle" | "standard";
export type WeekdayName = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface ReminderPreferenceResponse {
  version: number;
  enabled: boolean;
  intensity: ReminderIntensity;
  timezone: string;
  quiet_hours: { start: string; end: string };
  advisor_time: string;
  behavior_time: string;
  weekly_report: { day: WeekdayName; time: string };
  updated_at: string | null;
}

export interface ReminderPreferenceUpdateRequest extends Omit<ReminderPreferenceResponse, "version" | "updated_at"> {
  expected_version: number;
  idempotency_key: string;
}
