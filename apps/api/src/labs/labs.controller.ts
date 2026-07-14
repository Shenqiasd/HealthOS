import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AdminAccessGuard } from "../admin/admin-access.guard";
import type { AdminAuthenticatedRequest } from "../admin/admin-principal";
import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LabDocumentFinalizeDto, LabDocumentIntakeDto } from "./dto/lab-document.dto";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LabObservationConfirmationDto, LabObservationReviewDto } from "./dto/lab-observation.dto";
import { LabsService } from "./labs.service";

function userId(request: AuthenticatedRequest): string {
  const value = request.healthosPrincipal?.userId;
  if (!value) throw new UnauthorizedException("Missing authenticated user");
  return value;
}

@Controller("labs")
@UseGuards(AccessTokenGuard)
export class LabsController {
  constructor(@Inject(LabsService) private readonly labs: LabsService) {}

  @Post("documents")
  initiate(
    @Req() request: AuthenticatedRequest,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: LabDocumentIntakeDto,
  ) {
    return this.labs.initiate(userId(request), correlationId, {
      idempotencyKey: body.idempotency_key,
      sha256: body.sha256,
      mimeType: body.mime_type,
      sizeBytes: body.size_bytes,
    });
  }

  @Post("documents/:documentId/finalize")
  @HttpCode(200)
  finalize(
    @Req() request: AuthenticatedRequest,
    @Param("documentId", new ParseUUIDPipe()) documentId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: LabDocumentFinalizeDto,
  ) {
    void body.idempotency_key;
    return this.labs.finalize(userId(request), documentId, correlationId);
  }

  @Get("documents/:documentId")
  get(
    @Req() request: AuthenticatedRequest,
    @Param("documentId", new ParseUUIDPipe()) documentId: string,
  ) {
    return this.labs.get(userId(request), documentId);
  }

  @Post("observations/:observationId/confirm")
  @HttpCode(200)
  confirm(
    @Req() request: AuthenticatedRequest,
    @Param("observationId", new ParseUUIDPipe()) observationId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: LabObservationConfirmationDto,
  ) {
    return this.labs.confirmUser(userId(request), observationId, correlationId, {
      idempotencyKey: body.idempotency_key,
      expectedVersion: body.expected_version,
      code: body.code,
      value: body.value,
      unit: body.unit,
    });
  }
}

@Controller("admin/labs")
@UseGuards(AdminAccessGuard)
export class LabsReviewController {
  constructor(@Inject(LabsService) private readonly labs: LabsService) {}

  @Post("observations/:observationId/confirm")
  @HttpCode(200)
  confirm(
    @Req() request: AdminAuthenticatedRequest,
    @Param("observationId", new ParseUUIDPipe()) observationId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: LabObservationReviewDto,
  ) {
    const principal = request.healthosAdminPrincipal;
    if (!principal) throw new UnauthorizedException("Missing administrator principal");
    return this.labs.confirmReviewer(principal, observationId, correlationId, {
      idempotencyKey: body.idempotency_key,
      expectedVersion: body.expected_version,
      code: body.code,
      value: body.value,
      unit: body.unit,
      reason: body.reason,
    });
  }
}
