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
