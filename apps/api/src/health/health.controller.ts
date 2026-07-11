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
  HealthFreshnessResponse,
  HealthSyncResponse,
} from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { HealthSyncBatchDto } from "./dto/health-sync-batch.dto";
import { FreshnessService } from "./freshness.service";
import { HealthIngestionService } from "./health-ingestion.service";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

@Controller("health")
@UseGuards(AccessTokenGuard)
export class HealthIngestionController {
  constructor(
    @Inject(HealthIngestionService)
    private readonly ingestion: HealthIngestionService,
    @Inject(FreshnessService)
    private readonly freshness: FreshnessService,
  ) {}

  @Post("sync")
  @HttpCode(HttpStatus.OK)
  async sync(
    @Req() request: AuthenticatedRequest,
    @Body() dto: HealthSyncBatchDto,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<HealthSyncResponse> {
    const result = await this.ingestion.ingest(
      authenticatedUserId(request),
      correlationId,
      {
        idempotencyKey: dto.idempotency_key,
        deviceId: dto.device_id,
        anchorEpoch: dto.anchor_epoch,
        timezone: dto.timezone,
        facts: dto.facts.map((fact) => ({
          localDate: fact.local_date,
          metric: fact.metric,
          value: fact.value,
          coverage: fact.coverage,
          sourceVector: fact.source_vector.map((source) => ({
            sourceId: source.source_id,
            kind: source.kind,
            contribution: source.contribution,
          })),
        })),
      },
    );
    return {
      sync_run_id: result.syncRunId,
      server_sequence: result.serverSequence.toString(),
      created_revision_ids: result.createdRevisionIds,
    };
  }

  @Get("freshness")
  async getFreshness(
    @Req() request: AuthenticatedRequest,
  ): Promise<HealthFreshnessResponse> {
    const result = await this.freshness.forUser(authenticatedUserId(request), new Date());
    return {
      status: result.status,
      latest_local_date: result.latestLocalDate,
    };
  }
}
