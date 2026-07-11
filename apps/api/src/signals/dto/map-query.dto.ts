import { IsIn, IsOptional } from "class-validator";

export class MapQueryDto {
  @IsOptional()
  @IsIn(["sleep_recovery", "fatty_liver", "uric_acid", "waist_weight"])
  selected?: "sleep_recovery" | "fatty_liver" | "uric_acid" | "waist_weight";
}
