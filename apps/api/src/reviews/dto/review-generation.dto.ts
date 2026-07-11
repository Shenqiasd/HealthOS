import { IsISO8601, IsOptional, IsUUID, Matches } from "class-validator";

export class ReviewGenerationDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  week_start!: string;

  @IsISO8601({ strict: true })
  cutoff_at!: string;

  @IsUUID("4")
  idempotency_key!: string;
}

export class ReviewQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  week_start?: string;
}
