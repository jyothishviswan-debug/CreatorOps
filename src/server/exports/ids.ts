import { randomUUID } from "node:crypto";

// Opaque handle generation for export jobs/artifacts - mirrors src/server/reports/ids.ts's
// generateSnapshotRef exactly.
function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generateExportJobRef(): string {
  return `exp_${randomHex20()}`;
}

export function generateExportArtifactRef(): string {
  return `exa_${randomHex20()}`;
}
