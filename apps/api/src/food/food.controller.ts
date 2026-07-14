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

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { FoodCorrectionDto } from "./dto/food-correction.dto";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { FoodScanFinalizeDto, FoodScanIntakeDto } from "./dto/food-scan.dto";
import { FoodService } from "./food.service";

function userId(request: AuthenticatedRequest): string {
  const value = request.healthosPrincipal?.userId;
  if (!value) throw new UnauthorizedException("Missing authenticated user");
  return value;
}

@Controller("food")
@UseGuards(AccessTokenGuard)
export class FoodController {
  constructor(@Inject(FoodService) private readonly food: FoodService) {}

  @Post("scans")
  initiate(
    @Req() request: AuthenticatedRequest,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: FoodScanIntakeDto,
  ) {
    return this.food.initiate(userId(request), correlationId, {
      idempotency_key: body.idempotency_key,
      sha256: body.sha256,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      captured_at: body.captured_at,
    });
  }

  @Post("scans/:scanId/finalize")
  @HttpCode(200)
  finalize(
    @Req() request: AuthenticatedRequest,
    @Param("scanId", new ParseUUIDPipe()) scanId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: FoodScanFinalizeDto,
  ) {
    void body.idempotency_key;
    return this.food.finalize(userId(request), scanId, correlationId);
  }

  @Get("scans/:scanId")
  get(
    @Req() request: AuthenticatedRequest,
    @Param("scanId", new ParseUUIDPipe()) scanId: string,
  ) {
    return this.food.get(userId(request), scanId);
  }

  @Post("scans/:scanId/corrections")
  @HttpCode(200)
  correct(
    @Req() request: AuthenticatedRequest,
    @Param("scanId", new ParseUUIDPipe()) scanId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() body: FoodCorrectionDto,
  ) {
    return this.food.correct(userId(request), scanId, correlationId, {
      idempotency_key: body.idempotency_key,
      expected_version: body.expected_version,
      meal_presence: body.meal_presence,
      meal_completeness: body.meal_completeness,
      dish_codes: body.dish_codes,
      labels: body.labels,
      reason: body.reason,
    });
  }
}
