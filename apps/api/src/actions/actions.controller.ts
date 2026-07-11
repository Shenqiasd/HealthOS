import {
  Body,
  Controller,
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
import type { ActionFeedbackResponse } from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
import { ActionFeedbackService } from "./action-feedback.service";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ActionFeedbackDto } from "./dto/action-feedback.dto";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

@Controller("actions")
@UseGuards(AccessTokenGuard)
export class ActionsController {
  constructor(@Inject(ActionFeedbackService) private readonly feedback: ActionFeedbackService) {}

  @Post(":id/feedback")
  @HttpCode(HttpStatus.OK)
  async apply(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) actionId: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Body() dto: ActionFeedbackDto,
  ): Promise<ActionFeedbackResponse> {
    return this.feedback.apply(authenticatedUserId(request), actionId, correlationId, {
      command: dto.command,
      expectedVersion: dto.expected_version,
      idempotencyKey: dto.idempotency_key,
      ...(dto.reason_code ? { reasonCode: dto.reason_code } : {}),
    });
  }
}
