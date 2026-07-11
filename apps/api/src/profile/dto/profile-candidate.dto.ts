import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsString,
  Length,
} from "class-validator";

export class ProfileCandidateDto {
  @IsIn(["mobility_limitation"])
  candidate_type!: "mobility_limitation";

  @IsObject()
  structured_value!: { code: string; active: boolean };

  @IsString()
  @IsNotEmpty()
  @Length(1, 4_000)
  source_text!: string;

  @IsString()
  @Length(16, 128)
  idempotency_key!: string;
}
