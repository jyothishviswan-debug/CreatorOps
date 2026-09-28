import { getAdminFirestore } from "@/server/firebase/admin";

import {
  MAX_REPORT_VERSIONS,
  reportArtifactDocSchema,
  reportNarrativeRevisionDocSchema,
  reportRunHeadDocSchema,
  reportSnapshotDocSchema,
  reportVersionDocSchema,
  type ReportArtifactDoc,
  type ReportNarrativeRevisionDoc,
  type ReportRunHeadDoc,
  type ReportSnapshotDoc,
  type ReportVersionDoc,
} from "./types";

// Step 19A section 15: the ONLY Firestore collection Reports owns - one immutable finalized snapshot
// per finalize call. There is deliberately no collection for a live/ephemeral report run (section
// 15: "keep live runs ephemeral/unpersisted by default, only finalized snapshots get persisted") and
// no generic reporting-warehouse collection duplicating any canonical module's own business state
// (section 3/24).

export const REPORTS_COLLECTIONS = {
  reportSnapshots: "reportSnapshots",
  // Reports Final-Master: the publication domain model. `reportRuns` is the HEAD collection; `versions`
  // and `narrative` are subcollections under one run (mirrors financeAgreements/{ref}/versions - see
  // src/server/finance-agreements/firestore.ts's own comment on why a head+numbered-versions shape).
  // `reportArtifacts` is its own top-level collection (mirrors exports' own flat artifact metadata
  // shape) - an artifact belongs to exactly one (runRef, version, format) and is never nested under a
  // version doc itself (so listing every artifact for a run/version is one flat query, not a
  // subcollection fan-out).
  reportRuns: "reportRuns",
  versions: "versions",
  narrative: "narrative",
  reportArtifacts: "reportArtifacts",
} as const;

export function reportSnapshotsCollection() {
  return getAdminFirestore().collection(REPORTS_COLLECTIONS.reportSnapshots);
}

// --- Reports Final-Master: publication domain model collections ---------------------------------------
export function reportRunsCollection() {
  return getAdminFirestore().collection(REPORTS_COLLECTIONS.reportRuns);
}

export function reportRunVersionsCollection(runRef: string) {
  return reportRunsCollection().doc(runRef).collection(REPORTS_COLLECTIONS.versions);
}

export function reportRunNarrativeCollection(runRef: string, version: number) {
  return reportRunVersionsCollection(runRef).doc(versionDocId(version)).collection(REPORTS_COLLECTIONS.narrative);
}

export function reportArtifactsCollection() {
  return getAdminFirestore().collection(REPORTS_COLLECTIONS.reportArtifacts);
}

// Deterministic id ("1", "2", ...) - never sorts lexicographically for ordering; callers always order
// by the `version` field itself. Mirrors finance-agreements' own versionDocId exactly.
export function versionDocId(version: number): string {
  return String(version);
}

function narrativeRevisionDocId(sectionKey: string, revision: number): string {
  return `${sectionKey}__${revision}`;
}

// --- Reads (parse-on-read, null on missing/malformed - never throws on a corrupt doc) -----------------
export async function getReportRunHeadDoc(runRef: string): Promise<ReportRunHeadDoc | null> {
  const snap = await reportRunsCollection().doc(runRef).get();
  if (!snap.exists) return null;
  const parsed = reportRunHeadDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export async function getReportVersionDoc(runRef: string, version: number): Promise<ReportVersionDoc | null> {
  const snap = await reportRunVersionsCollection(runRef).doc(versionDocId(version)).get();
  if (!snap.exists) return null;
  const parsed = reportVersionDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

// Production hardening (base spec section 15 - query boundedness audit): this query previously had
// no explicit `.limit()` - a genuinely unbounded read shape by construction, even though
// reportVersionDocSchema's own `version` field (types.ts) already hard-caps at MAX_REPORT_VERSIONS
// via zod .max() (mirrors notes-meetings/action-item-service.ts's own identical fix for the sibling
// carried debt item - see that file's comment for the full rationale). Reusing the exact same
// already-proven constant as the query's own `.limit()` satisfies base spec section 15's two
// acceptable resolutions at once, never a second, inconsistent cap invented here.
export async function listReportVersionDocs(runRef: string): Promise<ReportVersionDoc[]> {
  const snap = await reportRunVersionsCollection(runRef).orderBy("version", "desc").limit(MAX_REPORT_VERSIONS).get();
  const docs: ReportVersionDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportVersionDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}

export async function listReportRunHeadDocsByActor(createdByUserRef: string, limit: number): Promise<ReportRunHeadDoc[]> {
  const snap = await reportRunsCollection().where("createdByUserRef", "==", createdByUserRef).orderBy("updatedAt", "desc").limit(limit).get();
  const docs: ReportRunHeadDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportRunHeadDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}

// A run is "finalized-visible" once its head has a currentFinalizedVersion - listable by reportId for
// any actor holding ordinary Reports view-level access to that report (see report-lifecycle-service.ts's
// own canViewReportVersion - visibility is enforced THERE, this is an unfiltered bounded query).
export async function listFinalizedReportRunHeadDocsByReportId(reportId: string, limit: number): Promise<ReportRunHeadDoc[]> {
  // A single-equality-filter + orderBy query (no composite index needed, same discipline as
  // listReportSnapshotDocsByActor above) - the currentFinalizedVersion !== null filter is applied in
  // memory over a bounded over-fetch, never a second Firestore inequality clause on top of the
  // equality filter.
  const OVER_FETCH_FACTOR = 3;
  const snap = await reportRunsCollection().where("reportId", "==", reportId).orderBy("updatedAt", "desc").limit(limit * OVER_FETCH_FACTOR).get();
  const docs: ReportRunHeadDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportRunHeadDocSchema.safeParse(doc.data());
    if (parsed.success && parsed.data.currentFinalizedVersion !== null) docs.push(parsed.data);
    if (docs.length >= limit) break;
  }
  return docs;
}

export async function getReportArtifactDoc(artifactRef: string): Promise<ReportArtifactDoc | null> {
  const snap = await reportArtifactsCollection().doc(artifactRef).get();
  if (!snap.exists) return null;
  const parsed = reportArtifactDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export async function listReportArtifactDocsForVersion(runRef: string, version: number): Promise<ReportArtifactDoc[]> {
  const snap = await reportArtifactsCollection().where("runRef", "==", runRef).where("version", "==", version).get();
  const docs: ReportArtifactDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportArtifactDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}

export async function listNarrativeRevisionDocs(runRef: string, version: number, sectionKey: string): Promise<ReportNarrativeRevisionDoc[]> {
  const snap = await reportRunNarrativeCollection(runRef, version).where("sectionKey", "==", sectionKey).orderBy("revision", "desc").get();
  const docs: ReportNarrativeRevisionDoc[] = [];
  for (const doc of snap.docs) {
    const parsed = reportNarrativeRevisionDocSchema.safeParse(doc.data());
    if (parsed.success) docs.push(parsed.data);
  }
  return docs;
}

// --- Transaction helpers (mirror finance-agreements/firestore.ts's own txGetX/txSetX/txCreateX shape
// exactly) - ALL reads a lifecycle transaction needs go through these, before any write. -------------
export async function txGetReportRunHead(tx: FirebaseFirestore.Transaction, runRef: string): Promise<ReportRunHeadDoc | null> {
  const snap = await tx.get(reportRunsCollection().doc(runRef));
  if (!snap.exists) return null;
  const parsed = reportRunHeadDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export async function txGetReportVersion(tx: FirebaseFirestore.Transaction, runRef: string, version: number): Promise<ReportVersionDoc | null> {
  const snap = await tx.get(reportRunVersionsCollection(runRef).doc(versionDocId(version)));
  if (!snap.exists) return null;
  const parsed = reportVersionDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export function txCreateReportRunHead(tx: FirebaseFirestore.Transaction, head: ReportRunHeadDoc): void {
  tx.create(reportRunsCollection().doc(head.runRef), reportRunHeadDocSchema.parse(head));
}

export function txSetReportRunHead(tx: FirebaseFirestore.Transaction, head: ReportRunHeadDoc): void {
  tx.set(reportRunsCollection().doc(head.runRef), reportRunHeadDocSchema.parse(head));
}

export function txCreateReportVersion(tx: FirebaseFirestore.Transaction, version: ReportVersionDoc): void {
  tx.create(reportRunVersionsCollection(version.runRef).doc(versionDocId(version.version)), reportVersionDocSchema.parse(version));
}

// Refuses (throws) to write a FINALIZED or SUPERSEDED version - the one place immutability-after-
// finalize is mechanically enforced, not merely documented. A caller that reaches this guard has
// already violated the lifecycle service's own precondition checks; this is defense in depth.
export function txSetReportVersion(tx: FirebaseFirestore.Transaction, version: ReportVersionDoc, allowFinalizing = false): void {
  if (!allowFinalizing && (version.status === "FINALIZED" || version.status === "SUPERSEDED")) {
    throw new Error("A FINALIZED or SUPERSEDED report version can never be written again.");
  }
  tx.set(reportRunVersionsCollection(version.runRef).doc(versionDocId(version.version)), reportVersionDocSchema.parse(version));
}

export function txCreateNarrativeRevision(tx: FirebaseFirestore.Transaction, doc: ReportNarrativeRevisionDoc): void {
  const id = narrativeRevisionDocId(doc.sectionKey, doc.revision);
  tx.create(reportRunNarrativeCollection(doc.runRef, doc.version).doc(id), reportNarrativeRevisionDocSchema.parse(doc));
}

export function txGetNarrativeRevisionRef(runRef: string, version: number, sectionKey: string, revision: number) {
  return reportRunNarrativeCollection(runRef, version).doc(narrativeRevisionDocId(sectionKey, revision));
}

// --- Artifacts: create-only (immutable metadata, mirrors the snapshot's own create-only discipline) ---
export async function createReportArtifactDoc(doc: ReportArtifactDoc): Promise<void> {
  const parsed = reportArtifactDocSchema.parse(doc);
  await reportArtifactsCollection().doc(parsed.artifactRef).create(parsed);
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
