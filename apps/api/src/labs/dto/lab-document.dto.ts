import { IsIn, IsInt, IsUUID, Matches, Max, Min } from "class-validator";

export class LabDocumentIntakeDto {
  @IsUUID()
  idempotency_key!: string;

  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;

  @IsIn(["application/pdf", "image/png", "image/jpeg"])
  mime_type!: "application/pdf" | "image/png" | "image/jpeg";

  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  size_bytes!: number;
}

export class LabDocumentFinalizeDto {
  @IsUUID()
  idempotency_key!: string;
}
