import { IsBoolean, IsIn, IsString, MaxLength, MinLength } from "class-validator";

import { CONSENT_PURPOSES, type ConsentPurpose } from "../consent.service";

export class WriteConsentDto {
  @IsIn(CONSENT_PURPOSES)
  purpose!: ConsentPurpose;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  document_version!: string;

  @IsBoolean()
  granted!: boolean;
}
