import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface LabParseRequest {
  documentId: string;
  objectKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
}

export interface LabParserObservation {
  code: string;
  value: string;
  unit: string;
  confidence: number;
  page: number;
  evidenceBox: { x: number; y: number; width: number; height: number };
  referenceRange?: string;
}

export interface LabParseResult {
  observations: LabParserObservation[];
}

export abstract class LabParserProvider {
  abstract parse(request: LabParseRequest): Promise<LabParseResult>;
}

export class LabProviderUnavailableError extends Error {
  constructor() {
    super("Lab parser provider is not configured");
  }
}

export class FailClosedLabParserProvider extends LabParserProvider {
  async parse(request: LabParseRequest): Promise<LabParseResult> {
    void request;
    throw new LabProviderUnavailableError();
  }
}

interface SyntheticManifest {
  synthetic_only: true;
  object: { sha256: string; mime_type: string; size_bytes: number };
  observations: Array<{
    code: string;
    value: string;
    unit: string;
    confidence: number;
    page: number;
    evidence_box: { x: number; y: number; width: number; height: number };
    reference_range?: string;
  }>;
}

export class SyntheticFixtureLabParserProvider extends LabParserProvider {
  constructor(private readonly fixtureDirectory: string) {
    super();
  }

  async parse(request: LabParseRequest): Promise<LabParseResult> {
    for (const file of await readdir(this.fixtureDirectory)) {
      if (!file.endsWith(".json")) continue;
      const manifest = JSON.parse(
        await readFile(path.join(this.fixtureDirectory, file), "utf8"),
      ) as SyntheticManifest;
      if (
        manifest.synthetic_only === true &&
        manifest.object?.sha256 === request.sha256 &&
        manifest.object.mime_type === request.mimeType &&
        manifest.object.size_bytes === request.sizeBytes
      ) {
        return {
          observations: manifest.observations.map((item) => ({
            code: item.code,
            value: item.value,
            unit: item.unit,
            confidence: item.confidence,
            page: item.page,
            evidenceBox: item.evidence_box,
            ...(item.reference_range ? { referenceRange: item.reference_range } : {}),
          })),
        };
      }
    }
    throw new LabProviderUnavailableError();
  }
}
