import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

@ValidatorConstraint({ name: "actionFeedbackCombination", async: false })
class ActionFeedbackCombinationConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, arguments_: ValidationArguments): boolean {
    const body = arguments_.object as { command?: string; reason_code?: string };
    if (body.command === "complete") return body.reason_code === undefined;
    if (body.command === "skip") {
      return ["no_time", "tired", "uncomfortable", "weather", "neutral"].includes(body.reason_code ?? "");
    }
    if (body.command === "lighter") return body.reason_code === "too_hard";
    if (body.command === "swap") return body.reason_code === undefined || [
      "too_hard", "no_time", "tired", "uncomfortable", "weather", "neutral",
    ].includes(body.reason_code);
    return false;
  }

  defaultMessage(): string {
    return "command and reason_code combination is unsupported";
  }
}

export class ActionFeedbackDto {
  @IsIn(["complete", "skip", "lighter", "swap"])
  @Validate(ActionFeedbackCombinationConstraint)
  command!: "complete" | "skip" | "lighter" | "swap";

  @IsOptional()
  @IsIn(["too_hard", "no_time", "tired", "uncomfortable", "weather", "neutral"])
  reason_code?: "too_hard" | "no_time" | "tired" | "uncomfortable" | "weather" | "neutral";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsUUID()
  idempotency_key!: string;
}
