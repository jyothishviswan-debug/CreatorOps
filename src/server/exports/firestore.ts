import { getAdminFirestore } from "@/server/firebase/admin";

import { exportJobDocSchema, type ExportJobDoc } from "./types";

// The ONE Firestore collection Export Center owns - one export job per create call. No generic
// reporting-warehouse collection, and no duplication of any canonical source module's own business
// state (mirrors src/server/reports/firestore.ts's own "one owned collection" discipline).
export const EXPORTS_COLLECTIONS = {
  exportJobs: "exportJobs",
} as const;

export function exportJobsCollection() {
  return getAdminFirestore().collection(EXPORTS_COLLECTIONS.exportJobs);
}

export async function createExportJobDoc(doc: ExportJobDoc): Promise<void> {
  const parsed = exportJobDocSchema.parse(doc);
  await exportJobsCollection().doc(parsed.jobRef).create(parsed);
}

// Lifecycle transitions - each a narrow, explicit `.update()` (never a blind overwrite of the whole
// doc), mirroring every other module's own "transition writes only the fields that changed"
// discipline.
export async function markExportJobGenerating(jobRef: string, generatingAt: string): Promise<void> {
  await exportJobsCollection().doc(jobRef).update({ status: "GENERATING", generatingAt });
}

export async function markExportJobCompleted(jobRef: string, fields: { completedAt: string; rowCount: number; truncated: boolean; artifactRef: string; fileName: string }): Promise<void> {
  await exportJobsCollection().doc(jobRef).update({ status: "COMPLETED", ...fields });
}

export async function markExportJobFailed(jobRef: string, fields: { failedAt: string; errorMessage: string }): Promise<void> {
  await exportJobsCollection().doc(jobRef).update({ status: "FAILED", ...fields });
}

export async function getExportJobDoc(jobRef: string): Promise<ExportJobDoc | null> {
  const snap = await exportJobsCollection().doc(jobRef).get();
  if (!snap.exists) return null;
  const parsed = exportJobDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

// Bounded, single-equality-filter + orderBy: an actor's own export jobs, newest first - the only
// Export Center query that needs a composite index (see firestore.indexes.json), same shape as
// Reports' own listReportSnapshotDocsByActor.
export async function listExportJobDocsByActor(createdByUserRef: string, limit: number): Promise<ExportJobDoc[]> {
  const snap = await exportJobsCollection().where("createdByUserRef", "==", createdByUserRef).orderBy("createdAt", "desc").limit(limit).get();
  const docs: ExportJobDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = exportJobDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}
