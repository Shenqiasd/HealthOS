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
  ProfileCandidateResponse,
  ProfileSnapshotResponse,
} from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's global validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ProfileCandidateDto } from "./dto/profile-candidate.dto";
import { ProfileCandidateService } from "./profile-candidate.service";
import { ProfileSnapshotService } from "./profile-snapshot.service";

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.healthosPrincipal?.userId;
  if (!userId) throw new UnauthorizedException("Missing authenticated user");
  return userId;
}

function candidateResponse(candidate: {
  id: string;
  candidateType: string;
  structuredValueJson: unknown;
  status: string;
  confirmedEventId: string | null;
}): ProfileCandidateResponse {
  return {
    id: candidate.id,
    candidate_type: candidate.candidateType,
    structured_value: candidate.structuredValueJson,
    status: candidate.status as ProfileCandidateResponse["status"],
    confirmed_event_id: candidate.confirmedEventId,
  };
}

@Controller("profile")
@UseGuards(AccessTokenGuard)
export class ProfileController {
  constructor(
    @Inject(ProfileCandidateService)
    private readonly candidates: ProfileCandidateService,
    @Inject(ProfileSnapshotService)
    private readonly snapshots: ProfileSnapshotService,
  ) {}

  @Post("candidates")
  @HttpCode(HttpStatus.OK)
  async proposeCandidate(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ProfileCandidateDto,
  ): Promise<ProfileCandidateResponse> {
    return candidateResponse(await this.candidates.propose(authenticatedUserId(request), {
      candidateType: dto.candidate_type,
      structuredValue: dto.structured_value,
      sourceText: dto.source_text,
      idempotencyKey: dto.idempotency_key,
    }));
  }

  @Post("candidates/:id/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmCandidate(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers(CORRELATION_ID_HEADER) correlationId: string,
  ): Promise<ProfileCandidateResponse> {
    const event = await this.candidates.confirm(
      authenticatedUserId(request),
      id,
      correlationId,
    );
    const candidate = await this.candidates.get(authenticatedUserId(request), id);
    if (candidate.confirmedEventId !== event.id) {
      throw new Error("Candidate confirmation did not persist atomically");
    }
    return candidateResponse(candidate);
  }

  @Get("snapshot")
  async currentSnapshot(
    @Req() request: AuthenticatedRequest,
  ): Promise<ProfileSnapshotResponse> {
    const snapshot = await this.snapshots.current(authenticatedUserId(request));
    return {
      version: snapshot.version,
      facts: snapshot.factsJson,
      source_sequence: snapshot.sourceSequence.toString(),
      snapshot_hash: snapshot.snapshotHash,
    };
  }
}
