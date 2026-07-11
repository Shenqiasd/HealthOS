import {
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
  isUUID,
} from "class-validator";

class AdminWorkflowActionBaseDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

}

@ValidatorConstraint({ name: "reviewAssigneeMatchesAction", async: false })
class ReviewAssigneeMatchesAction implements ValidatorConstraintInterface {
  validate(value: unknown, arguments_: ValidationArguments): boolean {
    const action = (arguments_.object as { action?: unknown }).action;
    return action === "reassign" ? typeof value === "string" && isUUID(value) : value === undefined;
  }

  defaultMessage(): string {
    return "assignee_id is required only for reassign";
  }
}

export class AdminReviewWorkflowActionDto extends AdminWorkflowActionBaseDto {
  @IsIn(["claim", "reassign", "release"])
  action!: "claim" | "reassign" | "release";

  @Validate(ReviewAssigneeMatchesAction)
  assignee_id?: string;
}

export class AdminSafetyWorkflowActionDto extends AdminWorkflowActionBaseDto {
  @IsIn(["acknowledge", "resolve", "reopen"])
  action!: "acknowledge" | "resolve" | "reopen";
}
