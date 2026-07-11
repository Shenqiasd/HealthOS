import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type {
  ConsentRecordResponse,
  ConsentSettingsResponse,
} from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import type { AuthenticatedRequest } from "../identity/access-token.guard";
import { AccessTokenGuard } from "../identity/access-token.guard";
import { ConsentService } from "./consent.service";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WriteConsentDto } from "./dto/write-consent.dto";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

@Controller("consents")
@UseGuards(AccessTokenGuard)
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly consent: ConsentService) {}

  @Get()
  async current(@Req() request: AuthenticatedRequest): Promise<ConsentSettingsResponse> {
    const current = await this.consent.current(authenticatedUserId(request));
    return {
      consent_epoch: current.consentEpoch,
      purposes: Object.fromEntries(
        Object.entries(current.purposes).map(([purpose, state]) => [
          purpose,
          {
            granted: state.granted,
            document_version: state.documentVersion,
            epoch: state.epoch,
            recorded_at: state.recordedAt.toISOString(),
          },
        ]),
      ),
    };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async record(
    @Req() request: AuthenticatedRequest,
    @Body() dto: WriteConsentDto,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<ConsentRecordResponse> {
    const record = await this.consent.record(authenticatedUserId(request), {
      purpose: dto.purpose,
      documentVersion: dto.document_version,
      granted: dto.granted,
      source: "ios",
      correlationId,
    });
    return {
      id: record.id,
      purpose: record.consentType as ConsentRecordResponse["purpose"],
      document_version: record.documentVersion,
      granted: record.granted,
      epoch: record.epoch,
      recorded_at: record.recordedAt.toISOString(),
    };
  }
}
