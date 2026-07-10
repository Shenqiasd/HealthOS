import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type {
  DeletionRequestResponse,
  DeletionStatusResponse,
  ExportJobResponse,
} from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrivacyRequestDto } from "./dto/privacy-request.dto";
import { PrivacyService } from "./privacy.service";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

function exportResponse(job: {
  id: string;
  status: ExportJobResponse["status"];
  objectKey: string | null;
  expiresAt: Date | null;
}): ExportJobResponse {
  return {
    id: job.id,
    status: job.status,
    artifact_available: job.status === "ready" && job.objectKey !== null,
    expires_at: job.expiresAt?.toISOString() ?? null,
  };
}

@Controller("privacy")
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}

  @Post("exports")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async requestExport(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PrivacyRequestDto,
  ): Promise<ExportJobResponse> {
    return exportResponse(
      await this.privacy.requestExport(authenticatedUserId(request), dto.idempotency_key),
    );
  }

  @Get("exports/:id")
  @UseGuards(AccessTokenGuard)
  async getExport(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<ExportJobResponse> {
    return exportResponse(await this.privacy.getExport(authenticatedUserId(request), id));
  }

  @Post("deletions")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async requestDeletion(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PrivacyRequestDto,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<DeletionRequestResponse> {
    const deletion = await this.privacy.requestDeletion(
      authenticatedUserId(request),
      dto.idempotency_key,
      correlationId,
    );
    return {
      id: deletion.job.id,
      status: deletion.job.status,
      status_token: deletion.statusToken,
    };
  }

  @Get("deletions/:id")
  async getDeletion(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("x-deletion-status-token") statusToken: string | undefined,
  ): Promise<DeletionStatusResponse> {
    if (!statusToken) throw new UnauthorizedException("Deletion status token required");
    const job = await this.privacy.getDeletionByStatusToken(id, statusToken);
    return {
      id: job.id,
      status: job.status,
      completed_at: job.completedAt?.toISOString() ?? null,
    };
  }
}
