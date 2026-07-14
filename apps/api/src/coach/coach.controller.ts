import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
import { CoachService } from "./coach.service";
// DTO values are required at runtime for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateCoachThreadDto } from "./dto/create-coach-thread.dto";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SendCoachMessageDto } from "./dto/send-coach-message.dto";

function userId(request: AuthenticatedRequest): string {
  const id = request.healthosPrincipal?.userId;
  if (!id) throw new UnauthorizedException("Missing authenticated user");
  return id;
}

@Controller("coach")
@UseGuards(AccessTokenGuard)
export class CoachController {
  constructor(@Inject(CoachService) private readonly coach: CoachService) {}

  @Post("threads")
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateCoachThreadDto) {
    return this.coach.createThread(userId(request), {
      clientThreadId: input.client_thread_id,
      idempotencyKey: input.idempotency_key,
    });
  }

  @Post("threads/:threadId/messages")
  @HttpCode(200)
  send(
    @Req() request: AuthenticatedRequest,
    @Param("threadId", new ParseUUIDPipe()) threadId: string,
    @Body() input: SendCoachMessageDto,
  ) {
    return this.coach.send({
      userId: userId(request),
      threadId,
      idempotencyKey: input.idempotency_key,
      expectedSummaryVersion: input.expected_summary_version,
      userText: input.user_text,
      ...(input.ocr_text ? { ocrText: input.ocr_text } : {}),
    });
  }

  @Get("threads/:threadId/messages")
  list(
    @Req() request: AuthenticatedRequest,
    @Param("threadId", new ParseUUIDPipe()) threadId: string,
  ) {
    return this.coach.listMessages(userId(request), threadId);
  }
}
