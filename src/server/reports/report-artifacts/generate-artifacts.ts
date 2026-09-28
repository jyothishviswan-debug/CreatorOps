import { createHash } from "node:crypto";

import { createReportArtifactDoc, getReportArtifactDoc, listReportArtifactDocsForVersion } from "../firestore";
import { generateArtifactRef } from "../ids";
import { buildSafeArtifactFilename } from "../report-sections/filename";
import { assembleFullReportSections } from "../report-sections/build-sections";
import type { ReportNarrativeSectionKey, ReportTemplateId } from "../report-templates";
import { getReportTemplateDefinition, reportNarrativeSectionKeySchema } from "../report-templates";
import type { ReportArtifactDoc, ReportArtifactFormat, ReportNarrativePointer, ReportVersionDoc } from "../types";
import { getReportArtifactStore, ReportArtifactStoreError } from "./artifact-store";
import { generateReportCsv } from "./csv-renderer";
import { generateReportPdf } from "./pdf-renderer";
import { generateReportXlsx } from "./xlsx-renderer";

// Reports Final-Master (spec sections 15/17/18/19): turns a FINALIZED ReportVersionDoc into its
// declared PDF/XLSX/CSV artifact bytes + governed metadata, idempotently. Runs OUTSIDE the finalize
// Firestore transaction (byte generation + Storage I/O are not transaction-safe operations) - the
// idempotency guarantee instead comes from generateArtifactRef's DETERMINISTIC id
// (sha256(runRef|version|format)): a retried call recomputes the identical ref, and both the artifact
// store's write-once precondition and Firestore's create-only write treat a second attempt as "already
// exists", which this module treats as SUCCESS (fetches and returns the existing doc) rather than an
// error - this is what makes finalize-then-generate-artifacts race-safe end to end (spec section 15).
function narrativeByKeyFromVersion(version: ReportVersionDoc): Partial<Record<ReportNarrativeSectionKey, { title: string; body: string; reviewStatus: string }>> {
  const out: Partial<Record<ReportNarrativeSectionKey, { title: string; body: string; reviewStatus: string }>> = {};
  for (const [key, pointer] of Object.entries(version.narrativePointers) as [string, ReportNarrativePointer][]) {
    const parsed = reportNarrativeSectionKeySchema.safeParse(key);
    if (!parsed.success) continue;
    out[parsed.data] = { title: pointer.title, body: pointer.body, reviewStatus: pointer.reviewStatus };
  }
  return out;
}

async function generateBytesForFormat(format: ReportArtifactFormat, version: ReportVersionDoc, templateId: ReportTemplateId): Promise<{ bytes: Uint8Array; contentType: string } | { skipped: string }> {
  const template = getReportTemplateDefinition(templateId);
  const evidence = version.evidence!;
  const sections = assembleFullReportSections(evidence.sectionModels as never, narrativeByKeyFromVersion(version));
  const versionLabel = `Version ${version.version} - ${version.status}`;

  if (format === "pdf") {
    const bytes = await generateReportPdf(sections, {
      templateTitle: template.title,
      reportPurpose: template.referencePattern,
      scopeLine: version.scopeSummary.note,
      periodLine: version.appliedFilters.period ? `Period: ${version.appliedFilters.period}` : "Period: full actor scope",
      generatedAtLine: `Generated: ${evidence.capturedAt}`,
      evidenceCutoffLine: `Evidence cutoff: ${evidence.sourceRevisionCutoff}`,
      versionLabel,
      finalizedLine: version.finalizedAt ? `Finalized ${version.finalizedAt}` : null,
      templateId,
    });
    return { bytes, contentType: "application/pdf" };
  }
  if (format === "xlsx") {
    const bytes = generateReportXlsx(sections, { templateTitle: template.title, versionLabel, generatedAtLine: evidence.capturedAt });
    return { bytes, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  }
  const csv = generateReportCsv(templateId, sections);
  if (!csv) return { skipped: "No table section was available to export as CSV for this version." };
  return { bytes: new TextEncoder().encode(csv.csv), contentType: "text/csv" };
}

export type EnsureArtifactsResult = { artifacts: ReportArtifactDoc[]; skipped: { format: ReportArtifactFormat; reason: string }[] };

export async function ensureArtifactsForFinalizedVersion(version: ReportVersionDoc, actorUserRef: string): Promise<EnsureArtifactsResult> {
  if (version.status !== "FINALIZED") throw new Error("ensureArtifactsForFinalizedVersion requires a FINALIZED version.");
  if (!version.evidence) throw new Error("A finalized version must have evidence.");

  const template = getReportTemplateDefinition(version.templateId as ReportTemplateId);
  const existing = await listReportArtifactDocsForVersion(version.runRef, version.version);
  const existingFormats = new Set(existing.map((a) => a.format));

  const artifacts: ReportArtifactDoc[] = [...existing];
  const skipped: { format: ReportArtifactFormat; reason: string }[] = [];

  for (const format of template.artifactFormats) {
    if (existingFormats.has(format)) continue;
    const artifactRef = generateArtifactRef(version.runRef, version.version, format);

    // Idempotent retry: if the Firestore doc already exists (a previous attempt succeeded but the
    // caller's own response was lost), just return it.
    const already = await getReportArtifactDoc(artifactRef);
    if (already) {
      artifacts.push(already);
      continue;
    }

    const generated = await generateBytesForFormat(format, version, version.templateId as ReportTemplateId);
    if ("skipped" in generated) {
      skipped.push({ format, reason: generated.skipped });
      continue;
    }

    const safeFilename = buildSafeArtifactFilename({ templateTitle: template.title, version: version.version, format });
    const checksumSha256 = createHash("sha256").update(generated.bytes).digest("hex");

    try {
      await getReportArtifactStore().put({ artifactRef, bytes: generated.bytes, format });
    } catch (error) {
      if (!(error instanceof ReportArtifactStoreError) || error.code !== "already_exists") throw error;
      // Bytes already stored by a concurrent/prior attempt - fall through to (re-)ensure the
      // Firestore doc exists too.
    }

    const doc: ReportArtifactDoc = {
      artifactRef,
      runRef: version.runRef,
      version: version.version,
      reportId: version.reportId,
      templateId: version.templateId,
      format,
      templateVersion: version.definitionVersion,
      safeFilename,
      contentType: generated.contentType,
      byteSize: generated.bytes.byteLength,
      checksumSha256,
      createdAt: new Date().toISOString(),
      createdByUserRef: actorUserRef,
    };
    try {
      await createReportArtifactDoc(doc);
      artifacts.push(doc);
    } catch {
      // Lost the create race to a concurrent finalize retry - read back whatever won.
      const winner = await getReportArtifactDoc(artifactRef);
      if (winner) artifacts.push(winner);
    }
  }

  return { artifacts, skipped };
}
