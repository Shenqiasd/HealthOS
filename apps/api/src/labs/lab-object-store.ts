import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { ServiceUnavailableException } from "@nestjs/common";

export interface LabObjectMetadata {
  sha256: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
}

export abstract class LabObjectStore {
  abstract head(objectKey: string): Promise<LabObjectMetadata>;
}

export class FailClosedLabObjectStore extends LabObjectStore {
  async head(objectKey: string): Promise<LabObjectMetadata> {
    void objectKey;
    throw new ServiceUnavailableException("Lab object storage is not configured");
  }
}

interface SyntheticManifest {
  synthetic_only: true;
  object: { sha256: string; mime_type: LabObjectMetadata["mimeType"]; size_bytes: number };
}

export class SyntheticFixtureLabObjectStore extends LabObjectStore {
  constructor(private readonly fixtureDirectory: string) {
    super();
  }

  async head(objectKey: string): Promise<LabObjectMetadata> {
    const sha256 = objectKey.split("/").at(-1);
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ServiceUnavailableException("Synthetic lab object identity is invalid");
    }
    for (const file of await readdir(this.fixtureDirectory)) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(path.join(this.fixtureDirectory, file), "utf8");
      const manifest = JSON.parse(raw) as SyntheticManifest;
      if (manifest.synthetic_only === true && manifest.object?.sha256 === sha256) {
        return {
          sha256,
          mimeType: manifest.object.mime_type,
          sizeBytes: manifest.object.size_bytes,
        };
      }
    }
    throw new ServiceUnavailableException("Synthetic lab object is unavailable");
  }
}
