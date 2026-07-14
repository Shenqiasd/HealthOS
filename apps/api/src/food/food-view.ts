import type {
  FoodCorrectionResponse,
  FoodDishCandidateResponse,
  FoodRiskLabelResponse,
  FoodScanResponse,
} from "@healthos/contracts";
import type { FoodCorrectionEvent, FoodDishCandidate, FoodRiskLabel, Prisma } from "@prisma/client";

type LoadedFoodScan = Prisma.FoodScanGetPayload<{
  include: {
    dishCandidates: true;
    labels: true;
    corrections: true;
  };
}>;

function dishView(row: FoodDishCandidate): FoodDishCandidateResponse {
  return {
    id: row.id,
    code: row.code as FoodDishCandidateResponse["code"],
    confidence: Number(row.confidence),
    evidence_box: row.evidence as unknown as FoodDishCandidateResponse["evidence_box"],
    disposition_code: row.dispositionCode as FoodDishCandidateResponse["disposition_code"],
  };
}

function labelView(row: FoodRiskLabel): FoodRiskLabelResponse {
  return {
    id: row.id,
    label: row.label as FoodRiskLabelResponse["label"],
    level: row.level as FoodRiskLabelResponse["level"],
    confidence: Number(row.confidence),
    evidence_box: row.evidence as unknown as FoodRiskLabelResponse["evidence_box"],
    disposition_code: row.dispositionCode as FoodRiskLabelResponse["disposition_code"],
  };
}

function correctionView(row: FoodCorrectionEvent): FoodCorrectionResponse {
  return {
    id: row.id,
    meal_presence: row.mealPresence as FoodCorrectionResponse["meal_presence"],
    meal_completeness: row.mealCompleteness as FoodCorrectionResponse["meal_completeness"],
    dish_codes: row.dishCodes as FoodCorrectionResponse["dish_codes"],
    labels: row.labelsJson as unknown as FoodCorrectionResponse["labels"],
    created_at: row.createdAt.toISOString(),
  };
}

export function foodScanView(row: LoadedFoodScan): FoodScanResponse {
  return {
    id: row.id,
    object_key: row.objectKey,
    sha256: row.sha256,
    mime_type: row.mimeType as FoodScanResponse["mime_type"],
    size_bytes: Number(row.sizeBytes),
    captured_at: row.capturedAt.toISOString(),
    status: row.status,
    failure_code: row.failureCode,
    meal_presence: row.mealPresence as FoodScanResponse["meal_presence"],
    meal_completeness: row.mealCompleteness as FoodScanResponse["meal_completeness"],
    overall_confidence: Number(row.overallConfidence),
    disposition_code: row.dispositionCode as FoodScanResponse["disposition_code"],
    version: row.version,
    dish_candidates: row.dishCandidates.map(dishView),
    risk_labels: row.labels.map(labelView),
    latest_correction: row.corrections[0] ? correctionView(row.corrections[0]) : null,
  };
}
