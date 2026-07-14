import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface FoodVisionRequest {
  scanId: string;
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FoodVisionEvidenceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FoodVisionDish {
  code: string;
  confidence: number;
  evidenceBox: FoodVisionEvidenceBox;
}

export interface FoodVisionLabel {
  label: string;
  level: string;
  confidence: number;
  evidenceBox: FoodVisionEvidenceBox;
}

export interface FoodVisionResult {
  mealPresence: "food" | "no_food" | "uncertain";
  mealCompleteness: "complete" | "cropped" | "unknown" | "unsupported";
  overallConfidence: number;
  dishes: FoodVisionDish[];
  labels: FoodVisionLabel[];
}

export abstract class FoodVisionProvider {
  abstract analyze(request: FoodVisionRequest): Promise<FoodVisionResult>;
}

export class FoodVisionProviderUnavailableError extends Error {
  constructor() {
    super("Food vision provider is not configured");
  }
}

export class FailClosedFoodVisionProvider extends FoodVisionProvider {
  async analyze(request: FoodVisionRequest): Promise<FoodVisionResult> {
    void request;
    throw new FoodVisionProviderUnavailableError();
  }
}

interface SyntheticManifest {
  synthetic_only: true;
  object: { sha256: string; mime_type: string; size_bytes: number };
  result: {
    meal_presence: FoodVisionResult["mealPresence"];
    meal_completeness: FoodVisionResult["mealCompleteness"];
    overall_confidence: number;
    dishes: Array<{
      code: string;
      confidence: number;
      evidence_box: FoodVisionEvidenceBox;
    }>;
    labels: Array<{
      label: string;
      level: string;
      confidence: number;
      evidence_box: FoodVisionEvidenceBox;
    }>;
  };
}

export class SyntheticFixtureFoodVisionProvider extends FoodVisionProvider {
  constructor(private readonly fixtureDirectory: string) {
    super();
  }

  async analyze(request: FoodVisionRequest): Promise<FoodVisionResult> {
    for (const file of await readdir(this.fixtureDirectory)) {
      if (!file.endsWith(".json")) continue;
      const manifest = JSON.parse(await readFile(path.join(this.fixtureDirectory, file), "utf8")) as SyntheticManifest;
      if (
        manifest.synthetic_only === true &&
        manifest.object?.sha256 === request.sha256 &&
        manifest.object.mime_type === request.mimeType &&
        manifest.object.size_bytes === request.sizeBytes
      ) {
        return {
          mealPresence: manifest.result.meal_presence,
          mealCompleteness: manifest.result.meal_completeness,
          overallConfidence: manifest.result.overall_confidence,
          dishes: manifest.result.dishes.map((item) => ({
            code: item.code,
            confidence: item.confidence,
            evidenceBox: item.evidence_box,
          })),
          labels: manifest.result.labels.map((item) => ({
            label: item.label,
            level: item.level,
            confidence: item.confidence,
            evidenceBox: item.evidence_box,
          })),
        };
      }
    }
    throw new FoodVisionProviderUnavailableError();
  }
}
