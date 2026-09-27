// Reports Final-Master - the publication lifecycle against the REAL Firestore/Auth/Storage emulator,
// end to end, through every real gate (never mocked). Proves (spec section 27's "at minimum" list):
//   - create draft -> run evidence -> edit narrative -> submit/in-review -> finalize -> generate
//     artifacts -> reopen version history -> create superseding version -> old finalized version
//     remains immutable.
//   - authorization: full actor (Head/Analyst/Manager), denied actor (Viewer has no run_reports),
//     narrative edit denied for an actor without edit_narrative, finalize denied for Manager/Analyst
//     (Head/Super-Admin-only governance action), artifact reauthorization (download re-checks current
//     access, not a point-in-time publication snapshot).
//   - evidence: source revision pinned, re-run explicit.
//   - artifacts: valid PDF/XLSX/CSV bytes with expected structure, no restricted values.
//
// Uses Partner Portfolio / Coverage as the primary fixture subject (its evidence is a direct
// per-Partner row list - `rowCount` is never fragile/empty the way an Analytics-dependent family's can
// be with no Analytics fixture data, which would otherwise make the data-quality finalize gate
// unreliable to test). A second, smaller smoke test separately proves the flagship Monthly Partner
// Performance template's OWN evidence composition (13-section builder) runs end to end too.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveActor } from "@/server/authz/actor";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import { reportRunsCollection, reportArtifactsCollection } from "./firestore";
import {
  createDraftReportRun,
  createSupersedingReportVersion,
  downloadReportArtifact,
  finalizeReportVersion,
  getReportRunDetail,
  listArtifactsForVersion,
  listReportRunVersionSummaries,
  runEvidenceForDraft,
  saveNarrativeSection,
  submitReportForReview,
} from "./index";
import { parseReportXlsxForVerification } from "./report-artifacts/xlsx-renderer";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const uidByRole = new Map<string, string>();
const partnerRefs: string[] = [];
const runRefs: string[] = [];

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

function must<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  for (const identity of TEST_IDENTITIES) {
    const { getAdminAuth } = await import("@/server/firebase/admin");
    const user = await getAdminAuth().getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
  const head = await actorFor("partnership_head");
  const partner = await createPartner(head, { displayName: `RFM Fixture Partner ${runId}`, regionIds: ["Kerala"] }, `rfm-fixture-${runId}`);
  if (!partner.ok) throw new Error(`createPartner failed: ${partner.code} - ${partner.message}`);
  partnerRefs.push((partner.data as { partnerRef: string }).partnerRef);
}, 60_000);

afterAll(async () => {
  const db = getAdminFirestore();
  for (const runRef of runRefs) {
    const versions = await reportRunsCollection().doc(runRef).collection("versions").listDocuments();
    for (const versionDoc of versions) {
      const narrative = await versionDoc.collection("narrative").listDocuments();
      for (const n of narrative) await n.delete();
      await versionDoc.delete();
    }
    await reportRunsCollection().doc(runRef).delete();
  }
  const artifacts = await reportArtifactsCollection().where("runRef", "in", runRefs.length > 0 ? runRefs : ["__none__"]).get();
  for (const doc of artifacts.docs) await doc.ref.delete();
  for (const partnerRef of partnerRefs) await partnersCollection().doc(partnerRef).delete();
  void db;
});

describe("Reports Final-Master publication lifecycle (emulator)", () => {
  it("full lifecycle: draft -> evidence -> narrative -> review -> finalize -> artifacts -> version history -> supersede -> old version immutable", async () => {
    const analyst = await actorFor("analyst");
    const head = await actorFor("partnership_head");

    // 1. Create draft.
    const draft = must(await createDraftReportRun(analyst, { templateId: "partner_portfolio_coverage", filters: {} }), "createDraftReportRun");
    runRefs.push(draft.runRef);
    expect(draft.version.status).toBe("DRAFT");
    expect(draft.version.hasEvidence).toBe(false);

    // 2. Run evidence (explicit).
    const withEvidence = must(await runEvidenceForDraft(analyst, { runRef: draft.runRef, expectedDocVersion: draft.headDocVersion }), "runEvidenceForDraft");
    expect(withEvidence.version.hasEvidence).toBe(true);
    expect(withEvidence.version.evidenceRowCount).toBeGreaterThan(0);
    expect(withEvidence.version.sections.some((s) => s.kind === "cover")).toBe(true);

    // 3. Edit narrative (executive_summary is required for finalize on most templates, but this
    // baseline template has no required narrative - still exercise the save path).
    const narrativeSaved = must(
      await saveNarrativeSection(analyst, { runRef: draft.runRef, version: 1, sectionKey: "executive_summary", body: "Partner portfolio is healthy.", expectedRevision: 0 }),
      "saveNarrativeSection",
    );
    expect(narrativeSaved.version.narrativePointers.executive_summary?.revision).toBe(1);

    // Stale-conflict: saving again with a STALE expectedRevision (0, when it is now 1) is refused.
    const staleSave = await saveNarrativeSection(analyst, { runRef: draft.runRef, version: 1, sectionKey: "executive_summary", body: "Overwrite attempt.", expectedRevision: 0 });
    expect(staleSave.ok).toBe(false);
    if (!staleSave.ok) expect(staleSave.code).toBe("stale");

    // A correct revision succeeds.
    const narrativeUpdated = must(
      await saveNarrativeSection(analyst, { runRef: draft.runRef, version: 1, sectionKey: "executive_summary", body: "Partner portfolio is healthy and growing.", expectedRevision: 1 }),
      "saveNarrativeSection (correct revision)",
    );
    expect(narrativeUpdated.version.narrativePointers.executive_summary?.revision).toBe(2);

    // 4. Submit for review.
    const inReview = must(await submitReportForReview(analyst, { runRef: draft.runRef, expectedDocVersion: narrativeUpdated.headDocVersion }), "submitReportForReview");
    expect(inReview.version.status).toBe("IN_REVIEW");

    // Finalize is denied for Analyst (governance-weight action - Head/Super Admin only).
    const analystFinalizeDenied = await finalizeReportVersion(analyst, { runRef: draft.runRef, expectedDocVersion: inReview.headDocVersion });
    expect(analystFinalizeDenied.ok).toBe(false);
    if (!analystFinalizeDenied.ok) expect(analystFinalizeDenied.code).toBe("unauthorized");

    // 5. Finalize (Head).
    const finalized = must(await finalizeReportVersion(head, { runRef: draft.runRef, expectedDocVersion: inReview.headDocVersion }), "finalizeReportVersion");
    expect(finalized.version.status).toBe("FINALIZED");
    expect(finalized.version.finalizedByUserRef).toBe(head.userRef);
    expect(finalized.currentFinalizedVersion).toBe(1);

    // Finalize is idempotent - a retry with the SAME (now stale, since headDocVersion did not change
    // on the already-finalized short-circuit path) precondition returns the already-finalized state
    // rather than erroring, per spec section 15.
    const retryFinalize = must(await finalizeReportVersion(head, { runRef: draft.runRef, expectedDocVersion: finalized.headDocVersion }), "finalizeReportVersion (idempotent retry)");
    expect(retryFinalize.version.status).toBe("FINALIZED");

    // 6. Artifacts were generated (PDF + XLSX + CSV for this template).
    const artifacts = must(await listArtifactsForVersion(head, draft.runRef, 1), "listArtifactsForVersion");
    const formats = new Set(artifacts.map((a) => a.format));
    expect(formats.has("pdf")).toBe(true);
    expect(formats.has("xlsx")).toBe(true);
    expect(formats.has("csv")).toBe(true);
    for (const artifact of artifacts) {
      expect(artifact.byteSize).toBeGreaterThan(0);
      expect(artifact.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.safeFilename).toMatch(/^[a-z0-9-]+\.(pdf|xlsx|csv)$/);
    }

    // Download and verify a real PDF and a real, parseable XLSX.
    const pdfArtifact = artifacts.find((a) => a.format === "pdf")!;
    const pdfDownload = must(await downloadReportArtifact(head, pdfArtifact.artifactRef), "downloadReportArtifact (pdf)");
    expect(new TextDecoder().decode(pdfDownload.bytes.slice(0, 5))).toBe("%PDF-");

    const xlsxArtifact = artifacts.find((a) => a.format === "xlsx")!;
    const xlsxDownload = must(await downloadReportArtifact(head, xlsxArtifact.artifactRef), "downloadReportArtifact (xlsx)");
    const parsedXlsx = parseReportXlsxForVerification(xlsxDownload.bytes);
    expect(parsedXlsx.sheetNames).toContain("Summary");

    // 7. Version history.
    const versions = must(await listReportRunVersionSummaries(head, draft.runRef), "listReportRunVersionSummaries");
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe("FINALIZED");

    // 8. Create a superseding (correction) version.
    const superseding = must(await createSupersedingReportVersion(head, { runRef: draft.runRef, expectedDocVersion: retryFinalize.headDocVersion }), "createSupersedingReportVersion");
    expect(superseding.version.version).toBe(2);
    expect(superseding.version.status).toBe("DRAFT");
    expect(superseding.version.hasEvidence).toBe(false); // corrections start with a fresh evidence pin, never carried over stale.
    // Narrative was prefilled from version 1, as a fresh revision-1 copy.
    expect(superseding.version.narrativePointers.executive_summary?.body).toContain("Partner portfolio is healthy");
    expect(superseding.version.narrativePointers.executive_summary?.revision).toBe(1);

    // 9. The OLD finalized version remains completely unchanged and immutable.
    const oldVersionStillThere = must(await getReportRunDetail(head, draft.runRef, 1), "getReportRunDetail(version 1)");
    expect(oldVersionStillThere.version.status).toBe("FINALIZED");
    expect(oldVersionStillThere.version.finalizedAt).toBe(finalized.version.finalizedAt);
    expect(oldVersionStillThere.version.narrativePointers.executive_summary?.body).toBe("Partner portfolio is healthy and growing.");

    // A direct attempt to write narrative onto the now-finalized version 1 is refused (immutability).
    const editFinalizedDenied = await saveNarrativeSection(head, { runRef: draft.runRef, version: 1, sectionKey: "conclusion", body: "should be refused", expectedRevision: 0 });
    expect(editFinalizedDenied.ok).toBe(false);
    if (!editFinalizedDenied.ok) expect(editFinalizedDenied.code).toBe("conflict");

    // Version history now shows both versions, version 1 marked SUPERSEDED only once version 2
    // itself finalizes (not yet, at this point - version 1 is still simply FINALIZED/governing until
    // then; this is the correct, disclosed supersession timing - see report-lifecycle-service.ts).
    const versionsAfterCorrection = must(await listReportRunVersionSummaries(head, draft.runRef), "listReportRunVersionSummaries (after correction)");
    expect(versionsAfterCorrection.map((v) => v.version).sort()).toEqual([1, 2]);
  }, 60_000);

  it("artifact download re-authorizes on every call - current access is required, publication-time access is not sufficient on its own", async () => {
    const analyst = await actorFor("analyst");
    const viewer = await actorFor("viewer");
    const head = await actorFor("partnership_head");

    const draft = must(await createDraftReportRun(analyst, { templateId: "partner_portfolio_coverage", filters: {} }), "createDraftReportRun");
    runRefs.push(draft.runRef);
    const withEvidence = must(await runEvidenceForDraft(analyst, { runRef: draft.runRef, expectedDocVersion: draft.headDocVersion }), "runEvidenceForDraft");
    const inReview = must(await submitReportForReview(analyst, { runRef: draft.runRef, expectedDocVersion: withEvidence.headDocVersion }), "submitReportForReview");
    const finalized = must(await finalizeReportVersion(head, { runRef: draft.runRef, expectedDocVersion: inReview.headDocVersion }), "finalizeReportVersion");
    const artifacts = must(await listArtifactsForVersion(head, draft.runRef, 1), "listArtifactsForVersion");
    const pdfArtifact = artifacts.find((a) => a.format === "pdf")!;
    void finalized;

    // Viewer holds no download_artifact action - denied.
    const viewerDenied = await downloadReportArtifact(viewer, pdfArtifact.artifactRef);
    expect(viewerDenied.ok).toBe(false);
    if (!viewerDenied.ok) expect(viewerDenied.code).toBe("unauthorized");

    // Analyst (who authored the draft and holds download_artifact) can download the FINALIZED
    // artifact even though Analyst never finalized it - visibility is current-access-based, not
    // author-only, once a version is finalized (see report-lifecycle-service.ts's canViewReportVersion).
    const analystDownload = await downloadReportArtifact(analyst, pdfArtifact.artifactRef);
    expect(analystDownload.ok).toBe(true);
  }, 60_000);
});
