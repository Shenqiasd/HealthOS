import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class QuietHoursDto {
  @Matches(TIME_PATTERN)
  start!: string;

  @Matches(TIME_PATTERN)
  end!: string;
}

export class WeeklyReportPreferenceDto {
  @IsIn(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])
  day!: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

  @Matches(TIME_PATTERN)
  time!: string;
}

export class ReminderPreferenceUpdateDto {
  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsUUID()
  idempotency_key!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsIn(["gentle", "standard"])
  intensity!: "gentle" | "standard";

  @IsString()
  @MaxLength(64)
  timezone!: string;

  @ValidateNested()
  @Type(() => QuietHoursDto)
  quiet_hours!: QuietHoursDto;

  @Matches(TIME_PATTERN)
  advisor_time!: string;

  @Matches(TIME_PATTERN)
  behavior_time!: string;

  @ValidateNested()
  @Type(() => WeeklyReportPreferenceDto)
  weekly_report!: WeeklyReportPreferenceDto;
}
