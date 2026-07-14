import type { LabDocumentResponse, LabObservationResponse } from "@healthos/contracts";
import type { LabDocument, LabObservation } from "@prisma/client";

export function labObservationView(row: LabObservation): LabObservationResponse {
  return {
    id: row.id,
    code: row.code,
    value: row.value,
    unit: row.unit,
    normalized_value: row.normalizedValue === null ? null : Number(row.normalizedValue),
    normalized_unit: row.normalizedUnit,
    reference_range: row.referenceRange,
    page: row.page,
    evidence_box: row.evidenceBox as unknown as LabObservationResponse["evidence_box"],
    confidence: Number(row.confidence),
    disposition_code: row.dispositionCode,
    confirmation_status: row.confirmationStatus === "usable" ? "usable"
      : row.confirmationStatus === "rejected" ? "rejected" : "needs_confirmation",
    version: row.version,
  };
}

export function labDocumentView(
  row: LabDocument & { observations?: LabObservation[] },
): LabDocumentResponse {
  return {
    id: row.id,
    object_key: row.objectKey,
    sha256: row.sha256,
    mime_type: row.mimeType as LabDocumentResponse["mime_type"],
    size_bytes: Number(row.sizeBytes),
    status: row.status,
    failure_code: row.failureCode,
    observations: (row.observations ?? []).map(labObservationView),
  };
}
