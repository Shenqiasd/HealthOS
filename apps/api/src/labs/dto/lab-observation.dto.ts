import { IsIn, IsInt, IsNumber, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

const LAB_CODES = ["ALT", "AST", "GGT", "URIC_ACID", "BMI", "WEIGHT", "WAIST"] as const;

export class LabObservationConfirmationDto {
  @IsUUID()
  idempotency_key!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expected_version!: number;

  @IsIn(LAB_CODES)
  code!: (typeof LAB_CODES)[number];

  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 6 })
  value!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;
}

export class LabObservationReviewDto extends LabObservationConfirmationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}
