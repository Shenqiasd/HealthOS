import { IsUUID } from "class-validator";

export class PrivacyRequestDto {
  @IsUUID()
  idempotency_key!: string;
}
