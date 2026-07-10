import { Injectable } from "@nestjs/common";

export type DependencyStatus = "not_configured" | "ok" | "error";

export interface ReadinessResponse {
  status: "not_ready" | "ready";
  dependencies: {
    database: { status: DependencyStatus };
    object_storage: { status: DependencyStatus };
    worker_lease: { status: DependencyStatus };
  };
}

@Injectable()
export class ReadinessService {
  getStatus(): ReadinessResponse {
    return {
      status: "not_ready",
      dependencies: {
        database: { status: "not_configured" },
        object_storage: { status: "not_configured" },
        worker_lease: { status: "not_configured" },
      },
    };
  }
}
