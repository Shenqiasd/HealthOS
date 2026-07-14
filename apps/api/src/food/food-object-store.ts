import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { ServiceUnavailableException } from "@nestjs/common";

export interface FoodObjectMetadata {
  sha256: string;
  mimeType: "image/png" | "image/jpeg";
  sizeBytes: number;
}

export abstract class FoodObjectStore {
  abstract head(objectKey: string): Promise<FoodObjectMetadata>;
}

export class FailClosedFoodObjectStore extends FoodObjectStore {
  async head(objectKey: string): Promise<FoodObjectMetadata> {
    void objectKey;
    throw new ServiceUnavailableException("Food object storage is not configured");
  }
}

interface SyntheticManifest {
  synthetic_only: true;
  object: { sha256: string; mime_type: FoodObjectMetadata["mimeType"]; size_bytes: number };
}

export class SyntheticFixtureFoodObjectStore extends FoodObjectStore {
  constructor(private readonly fixtureDirectory: string) {
    super();
  }

  async head(objectKey: string): Promise<FoodObjectMetadata> {
    const sha256 = objectKey.split("/").at(-1);
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ServiceUnavailableException("Synthetic Food object identity is invalid");
    }
    for (const file of await readdir(this.fixtureDirectory)) {
      if (!file.endsWith(".json")) continue;
      const manifest = JSON.parse(await readFile(path.join(this.fixtureDirectory, file), "utf8")) as SyntheticManifest;
      if (manifest.synthetic_only === true && manifest.object?.sha256 === sha256) {
        return {
          sha256,
          mimeType: manifest.object.mime_type,
          sizeBytes: manifest.object.size_bytes,
        };
      }
    }
    throw new ServiceUnavailableException("Synthetic Food object is unavailable");
  }
}
