import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

const DISH_CODES = [
  "red_braised_pork",
  "white_rice",
  "milk_tea",
  "fried_dish",
  "ambiguous_beverage",
  "mixed_meat_dish",
  "beer",
  "soup",
  "vegetables",
] as const;
const RISK_LABELS = ["sugary_drink", "alcohol", "high_oil", "refined_carbohydrate", "high_purine"] as const;

export class FoodLabelCorrectionDto {
  @IsIn(RISK_LABELS)
  label!: (typeof RISK_LABELS)[number];

  @IsIn(["unknown", "low", "medium", "high"])
  level!: "unknown" | "low" | "medium" | "high";
}

export class FoodCorrectionDto {
  @IsUUID()
  idempotency_key!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expected_version!: number;

  @IsIn(["food", "no_food", "uncertain"])
  meal_presence!: "food" | "no_food" | "uncertain";

  @IsIn(["complete", "cropped", "unknown"])
  meal_completeness!: "complete" | "cropped" | "unknown";

  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsIn(DISH_CODES, { each: true })
  dish_codes!: Array<(typeof DISH_CODES)[number]>;

  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique((item: FoodLabelCorrectionDto) => item.label)
  @ValidateNested({ each: true })
  @Type(() => FoodLabelCorrectionDto)
  labels!: FoodLabelCorrectionDto[];

  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}
