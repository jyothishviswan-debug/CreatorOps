import { createHash, randomUUID } from "node:crypto";

import type { ReportArtifactFormat } from "./types";

// Step 19A: opaque handle generation for a finalized Report Snapshot - mirrors
// src/server/operations/ids.ts's generateTaskRef/generateReminderRef exactly (a snapshot is not
// itself a deterministic per-source record; many snapshots can legitimately exist for the same
// reportId, one per finalize call).
function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generateSnapshotRef(): string {
  return `rsn_${randomHex20()}`;
}

// Reports Final-Master: a run's own opaque handle - same "not deterministic, many runs may exist for
// the same reportId/templateId" reasoning as generateSnapshotRef above.
export function generateRunRef(): string {
  return `rrun_${randomHex20()}`;
}

// Artifact refs are DETERMINISTIC (sha256 of runRef|version|format, never random) - so a retried
// finalize regenerates the exact same ref rather than leaking an orphaned duplicate artifact, the
// idempotency mechanism report-artifacts/generate-artifacts.ts relies on.
export function generateArtifactRef(runRef: string, version: number, format: ReportArtifactFormat): string {
  const hash = createHash("sha256").update(`${runRef}|${version}|${format}`).digest("hex").slice(0, 32);
  return `rar_${hash}`;
}
