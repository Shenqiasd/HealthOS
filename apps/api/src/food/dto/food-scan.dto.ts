import { IsISO8601, IsIn, IsInt, IsUUID, Matches, Max, Min } from "class-validator";

export class FoodScanIntakeDto {
  @IsUUID()
  idempotency_key!: string;

  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;

  @IsIn(["image/png", "image/jpeg"])
  mime_type!: "image/png" | "image/jpeg";

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  size_bytes!: number;

  @IsISO8601({ strict: true, strictSeparator: true })
  captured_at!: string;
}

export class FoodScanFinalizeDto {
  @IsUUID()
  idempotency_key!: string;
}
