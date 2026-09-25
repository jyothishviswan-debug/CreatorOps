import { getAdminFirestore } from "@/server/firebase/admin";

import { reportSnapshotDocSchema, type ReportSnapshotDoc } from "./types";

// Step 19A section 15: the ONLY Firestore collection Reports owns - one immutable finalized snapshot
// per finalize call. There is deliberately no collection for a live/ephemeral report run (section
// 15: "keep live runs ephemeral/unpersisted by default, only finalized snapshots get persisted") and
// no generic reporting-warehouse collection duplicating any canonical module's own business state
// (section 3/24).

export const REPORTS_COLLECTIONS = {
  reportSnapshots: "reportSnapshots",
} as const;

export function reportSnapshotsCollection() {
  return getAdminFirestore().collection(REPORTS_COLLECTIONS.reportSnapshots);
}

// IMMUTABLE once written - only a create exists here, mirroring every other module's own
// "txCreateXVersion, never a set/update" discipline for anything meant to be append-only evidence.
export async function createReportSnapshotDoc(doc: ReportSnapshotDoc): Promise<void> {
  const parsed = reportSnapshotDocSchema.parse(doc);
  await reportSnapshotsCollection().doc(parsed.snapshotRef).create(parsed);
}

export async function getReportSnapshotDoc(snapshotRef: string): Promise<ReportSnapshotDoc | null> {
  const snap = await reportSnapshotsCollection().doc(snapshotRef).get();
  if (!snap.exists) return null;
  const parsed = reportSnapshotDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

// Bounded, single-equality-filter + orderBy: an actor's own finalized snapshots, newest first. The
// only Reports query that needs a composite index (see firestore.indexes.json) - listing BY REPORT
// is deliberately not offered in 19A (an actor's own snapshot history is enough; a snapshotRef from a
// finalize response is the drilldown handle for any specific one - see getFinalizedSnapshot).
export async function listReportSnapshotDocsByActor(createdByUserRef: string, limit: number): Promise<ReportSnapshotDoc[]> {
  const snap = await reportSnapshotsCollection().where("createdByUserRef", "==", createdByUserRef).orderBy("generatedAt", "desc").limit(limit).get();
  const docs: ReportSnapshotDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportSnapshotDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}
