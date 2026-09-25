import { randomUUID } from "node:crypto";

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
