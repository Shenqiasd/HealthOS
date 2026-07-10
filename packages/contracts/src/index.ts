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
