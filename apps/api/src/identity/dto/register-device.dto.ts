import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class RegisterDeviceDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  device_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  app_version!: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  apns_token?: string;
}
