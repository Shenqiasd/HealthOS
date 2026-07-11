import {
  Controller,
  Get,
  Headers,
  Inject,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { TodayViewModel } from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";
import type { FastifyReply } from "fastify";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
import { TodayService } from "./today.service";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = etag.slice(2);
  return ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === opaque;
  });
}

@Controller("today")
@UseGuards(AccessTokenGuard)
export class TodayController {
  constructor(@Inject(TodayService) private readonly today: TodayService) {}

  @Get()
  async current(
    @Req() request: AuthenticatedRequest,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TodayViewModel | undefined> {
    const response = await this.today.get(authenticatedUserId(request), correlationId);
    const etag = `W/"${response.cache_identity}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "private, no-cache");
    if (matchesEtag(ifNoneMatch, etag)) {
      reply.status(304);
      return undefined;
    }
    return response;
  }
}
