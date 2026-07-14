import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";

export class SendCoachMessageDto {
  @IsUUID()
  idempotency_key!: string;

  @IsInt()
  @Min(0)
  expected_summary_version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  user_text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  ocr_text?: string;
}
