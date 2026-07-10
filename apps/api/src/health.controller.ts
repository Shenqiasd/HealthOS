import { Controller, Get, HttpCode, HttpStatus, Inject } from "@nestjs/common";

import { ReadinessService, type ReadinessResponse } from "./common/readiness.service";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  ready(): ReadinessResponse {
    return this.readiness.getStatus();
  }
}
