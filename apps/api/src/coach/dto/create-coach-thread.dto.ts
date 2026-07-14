import { IsUUID } from "class-validator";

export class CreateCoachThreadDto {
  @IsUUID()
  client_thread_id!: string;

  @IsUUID()
  idempotency_key!: string;
}
