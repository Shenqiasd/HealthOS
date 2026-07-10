import { IsString, MinLength } from "class-validator";

export class AppleLoginDto {
  @IsString()
  @MinLength(32)
  identity_token!: string;

  @IsString()
  @MinLength(32)
  nonce!: string;
}
