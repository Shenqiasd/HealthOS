import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  Body,
  BadRequestException,
} from "@nestjs/common";
import type {
  ReviewGenerationResponse,
  ReviewShareResponse,
  ReviewShareVariant,
  WeeklyReviewViewModel,
} from "@healthos/contracts";

import { AccessTokenGuard, type AuthenticatedRequest } from "../identity/access-token.guard";
// Runtime metadata is required by Nest's validation pipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReviewGenerationDto, ReviewQueryDto } from "./dto/review-generation.dto";
import { ReviewsService } from "./reviews.service";

@Controller("reviews")
@UseGuards(AccessTokenGuard)
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Post("generations")
  async request(@Req() request: AuthenticatedRequest, @Body() body: ReviewGenerationDto): Promise<ReviewGenerationResponse> {
    return this.reviews.request(this.userId(request), body);
  }

  @Get("current")
  async current(@Req() request: AuthenticatedRequest, @Query() query: ReviewQueryDto): Promise<WeeklyReviewViewModel> {
    return this.reviews.current(this.userId(request), query.week_start);
  }

  @Get(":reviewId/shares/:variant")
  async share(
    @Req() request: AuthenticatedRequest,
    @Param("reviewId") reviewId: string,
    @Param("variant") variant: string,
  ): Promise<ReviewShareResponse> {
    if (!(["redacted", "private"] as const).includes(variant as ReviewShareVariant)) {
      throw new BadRequestException("Unsupported review share variant");
    }
    return this.reviews.share(this.userId(request), reviewId, variant as ReviewShareVariant);
  }

  private userId(request: AuthenticatedRequest): string {
    const userId = request.healthosPrincipal?.userId;
    if (!userId) throw new UnauthorizedException("Missing authenticated user");
    return userId;
  }
}
