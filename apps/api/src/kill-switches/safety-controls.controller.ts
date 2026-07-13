import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AdminAccessGuard } from "../admin/admin-access.guard";
import type { AdminAuthenticatedRequest } from "../admin/admin-principal";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SafetyControlActionDto } from "./dto/safety-control-action.dto";
import { SafetyControlsService } from "./safety-controls.service";

@Controller("admin/safety-controls")
@UseGuards(AdminAccessGuard)
export class SafetyControlsController {
  constructor(@Inject(SafetyControlsService) private readonly controls: SafetyControlsService) {}

  @Get()
  list(@Req() request: AdminAuthenticatedRequest) {
    return this.controls.list(this.principal(request));
  }

  @Post("actions")
  @HttpCode(200)
  mutate(
    @Req() request: AdminAuthenticatedRequest,
    @Headers(CORRELATION_ID_HEADER) correlationId: string | undefined,
    @Body() body: SafetyControlActionDto,
  ) {
    if (!correlationId) throw new BadRequestException("Correlation identifier is required");
    return this.controls.mutate(this.principal(request), body, correlationId);
  }

  private principal(request: AdminAuthenticatedRequest) {
    if (!request.healthosAdminPrincipal) throw new UnauthorizedException("Missing administrator principal");
    return request.healthosAdminPrincipal;
  }
}
