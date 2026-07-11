import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import { HEALTH_METRICS, type HealthMetric } from "../health-types";

class HealthSourceContributionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  source_id!: string;

  @IsIn(["phone", "watch", "third_party", "user"])
  kind!: "phone" | "watch" | "third_party" | "user";

  @IsNumber()
  @Min(0)
  @Max(1)
  contribution!: number;
}

class DailyHealthFactDto {
  @IsString()
  local_date!: string;

  @IsIn(HEALTH_METRICS)
  metric!: HealthMetric;

  @IsNumber()
  value!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  coverage!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => HealthSourceContributionDto)
  source_vector!: HealthSourceContributionDto[];
}

export class HealthSyncBatchDto {
  @IsUUID()
  idempotency_key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  device_id!: string;

  @IsInt()
  @Min(0)
  anchor_epoch!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => DailyHealthFactDto)
  facts!: DailyHealthFactDto[];
}
