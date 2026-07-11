import { Controller, Get, Inject, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { MapViewModel } from "@healthos/contracts";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MapQueryDto } from "./dto/map-query.dto";
import { SignalsService } from "./signals.service";

@Controller("map")
@UseGuards(AccessTokenGuard)
export class SignalsController {
  constructor(@Inject(SignalsService) private readonly signals: SignalsService) {}

  @Get()
  async get(@Req() request: AuthenticatedRequest, @Query() query: MapQueryDto): Promise<MapViewModel> {
    const userId = request.healthosPrincipal?.userId;
    if (!userId) throw new UnauthorizedException("Missing authenticated user");
    return this.signals.get(userId, query.selected);
  }
}
