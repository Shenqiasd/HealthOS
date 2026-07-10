import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { DatabaseService } from "../database/prisma.service";

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
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async getStatus(): Promise<ReadinessResponse> {
    let database: DependencyStatus = "not_configured";
    if (process.env.DATABASE_URL) {
      try {
        await this.database.$queryRaw(Prisma.sql`SELECT 1`);
        database = "ok";
      } catch {
        database = "error";
      }
    }

    return {
      status: "not_ready",
      dependencies: {
        database: { status: database },
        object_storage: { status: "not_configured" },
        worker_lease: { status: "not_configured" },
      },
    };
  }
}
