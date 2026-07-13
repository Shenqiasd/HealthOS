import { Body, Controller, Get, Inject, Put, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { ReminderPreferenceResponse } from "@healthos/contracts";

import type { AuthenticatedRequest } from "../identity/access-token.guard";
import { AccessTokenGuard } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReminderPreferenceUpdateDto } from "./dto/reminder-preference.dto";
import { RemindersService } from "./reminders.service";

function userId(request: AuthenticatedRequest): string {
  const value = request.healthosPrincipal?.userId;
  if (!value) throw new UnauthorizedException("Missing authenticated user");
  return value;
}

@Controller("reminders/preferences")
@UseGuards(AccessTokenGuard)
export class RemindersController {
  constructor(@Inject(RemindersService) private readonly reminders: RemindersService) {}

  @Get()
  get(@Req() request: AuthenticatedRequest): Promise<ReminderPreferenceResponse> {
    return this.reminders.get(userId(request));
  }

  @Put()
  update(
    @Req() request: AuthenticatedRequest,
    @Body() body: ReminderPreferenceUpdateDto,
  ): Promise<ReminderPreferenceResponse> {
    return this.reminders.update(userId(request), body);
  }
}
