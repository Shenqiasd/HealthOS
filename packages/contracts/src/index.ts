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
