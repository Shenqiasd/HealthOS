import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AdminAccessGuard } from "./admin-access.guard";
import type { AdminAuthenticatedRequest } from "./admin-principal";
import { AdminService } from "./admin.service";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AdminQueueQueryDto } from "./dto/admin-query.dto";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AdminReviewWorkflowActionDto, AdminSafetyWorkflowActionDto } from "./dto/admin-workflow-action.dto";

@Controller("admin")
@UseGuards(AdminAccessGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get("review-tasks")
  reviewTasks(@Req() request: AdminAuthenticatedRequest, @Query() query: AdminQueueQueryDto) {
    return this.admin.reviewTasks(this.principal(request), query);
  }

  @Post("review-tasks/:taskId/actions")
  @HttpCode(200)
  mutateReviewTask(
    @Req() request: AdminAuthenticatedRequest,
    @Param("taskId", new ParseUUIDPipe()) taskId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: AdminReviewWorkflowActionDto,
  ) {
    return this.admin.mutateReviewTask(this.principal(request), taskId, {
      action: body.action,
      expectedVersion: body.expected_version,
      reason: body.reason,
      correlationId: this.correlationId(correlationId),
      ...(body.assignee_id ? { assigneeId: body.assignee_id } : {}),
    });
  }

  @Get("safety-incidents")
  safetyIncidents(@Req() request: AdminAuthenticatedRequest, @Query() query: AdminQueueQueryDto) {
    return this.admin.safetyIncidents(this.principal(request), query);
  }

  @Post("safety-incidents/:incidentId/actions")
  @HttpCode(200)
  mutateSafetyIncident(
    @Req() request: AdminAuthenticatedRequest,
    @Param("incidentId", new ParseUUIDPipe()) incidentId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: AdminSafetyWorkflowActionDto,
  ) {
    return this.admin.mutateSafetyIncident(this.principal(request), incidentId, {
      action: body.action,
      expectedVersion: body.expected_version,
      reason: body.reason,
      correlationId: this.correlationId(correlationId),
    });
  }

  private principal(request: AdminAuthenticatedRequest) {
    if (!request.healthosAdminPrincipal) throw new UnauthorizedException("Missing administrator principal");
    return request.healthosAdminPrincipal;
  }

  private correlationId(value: string | undefined): string {
    if (!value) throw new BadRequestException("Correlation identifier is required");
    return value;
  }
}
