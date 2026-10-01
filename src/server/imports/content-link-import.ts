import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { requireImportsModuleAccess } from "@/server/analytics/analytics-gate";
import { parseWorkbookBuffer, type ParsedSheet } from "@/server/analytics/xlsx-parser";
import { getUserDocByRef } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { getAssignmentDocByRef } from "@/server/assignments/firestore";
import { ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION } from "@/server/content/content-service";
import { requireContentAccess } from "@/server/content/content-gate";
import { recordContentLinksOnBehalf } from "@/server/content/manager-submission-service";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { classifyImportReasonCode, classifyServiceErrorCode, classifySystemError } from "./error-taxonomy";
import { checkImportFileSafety } from "./file-safety";
import { ImportAdapterError, registerImportTarget, type ImportRowOutcomeSummary } from "./target-registry";

// Finding #44 (user-decided): the Manager content-link BULK import target - a genuinely new, separate
// target kind (never a third value jammed into AnalyticsTargetKind, which names an Analytics concept
// this is not). Reuses the proven envelope this module already established for a second, non-Analytics
// target (see contract-bundle-import.ts, this file's own direct structural template): sha256 source-hash
// idempotency, row-level safe-error classification via the shared taxonomy, a resumable-by-replay batch,
// and the same registerImportTarget/getImportTarget seam. Every actual write goes through the ALREADY
// canonical, already-gated recordContentLinksOnBehalf (content/manager-submission-service.ts) - this file
// never writes a Content/Revision/publication-claim document itself, and it REQUIRES an Assignment
// context on every row (that function's own "never orphan Content" rule applies here unchanged).
//
// Row shape: one spreadsheet row = one (Assignment Ref, Platform, URL) triple. Rows for the SAME
// Assignment Ref (anywhere in the file) are grouped and submitted together as ONE call - exactly what a
// real multi-link submission looks like, and the only shape recordContentLinksOnBehalf's own one-
// revision-per-call contract supports; submitting them as N separate single-link calls would silently
// create N separate revisions instead of one, which is not what "record these links for this Assignment"
// means.

const HEADER_ALIASES: Record<string, string[]> = {
  assignmentRef: ["assignment ref", "assignmentref", "assignment"],
  platform: ["platform"],
  url: ["url", "link", "post url"],
};

// Exported for unit tests only (row parsing/grouping/claim-id determinism) - not part of the adapter's
// public runtime surface (that is registerContentLinkImportTarget and the list/get history functions).
export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

export function resolveRow(row: Record<string, unknown>): Record<string, string | undefined> {
  const byNormalizedHeader = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) byNormalizedHeader.set(normalizeHeader(key), value);

  const resolved: Record<string, string | undefined> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const value = byNormalizedHeader.get(alias);
      if (value !== undefined && value !== null && String(value).trim().length > 0) {
        resolved[field] = String(value).trim();
        break;
      }
    }
  }
  return resolved;
}

export type EnumeratedRow = { sheetName: string; rowNumber: number; assignmentRef: string | null; platform: string | null; url: string | null; rawComplete: boolean };

export function enumerateRows(sheets: ParsedSheet[]): EnumeratedRow[] {
  const out: EnumeratedRow[] = [];
  for (const sheet of sheets) {
    sheet.rows.forEach((row, index) => {
      const nonEmpty = Object.values(row).some((v) => v !== null && v !== undefined && String(v).trim().length > 0);
      if (!nonEmpty) return; // silently skip a wholly blank row
      const resolved = resolveRow(row as Record<string, unknown>);
      out.push({
        sheetName: sheet.sheetName,
        rowNumber: index + 2,
        assignmentRef: resolved.assignmentRef ?? null,
        platform: resolved.platform ?? null,
        url: resolved.url ?? null,
        rawComplete: Boolean(resolved.assignmentRef && resolved.platform && resolved.url),
      });
    });
  }
  return out;
}

export type ContentLinkRowOutcome = "CREATE" | "UNCHANGED" | "AMBIGUOUS" | "ERROR" | "AUTHORIZATION" | "QUARANTINED";

export type ContentLinkRowResult = {
  sheetName: string;
  sourceRowNumber: number;
  outcome: ContentLinkRowOutcome;
  assignmentRef: string | null;
  platform: string | null;
  url: string | null;
  message: string | null;
  contentRef: string | null;
};

export function groupClaimId(sourceHash: string, assignmentRef: string): string {
  return createHash("sha256").update(`content_links:${sourceHash}:${assignmentRef}`).digest("hex");
}

const contentLinkGroupClaimDocSchema = z.object({
  claimId: z.string().min(1),
  sourceHash: z.string().min(1),
  assignmentRef: z.string().min(1),
  status: z.enum(["COMPLETED"]),
  contentRef: z.string().min(1),
  revisionNumber: z.number().int().min(1),
  claimedAt: z.string().min(1),
});
type ContentLinkGroupClaimDoc = z.infer<typeof contentLinkGroupClaimDocSchema>;

function contentLinkGroupClaimsCollection() {
  return getAdminFirestore().collection("importContentLinkGroupClaims");
}

async function getGroupClaim(claimId: string): Promise<ContentLinkGroupClaimDoc | null> {
  const snap = await contentLinkGroupClaimsCollection().doc(claimId).get();
  if (!snap.exists) return null;
  const parsed = contentLinkGroupClaimDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export type RowGroup = { assignmentRef: string; rows: EnumeratedRow[] };

// Groups malformed rows (missing any of the three required columns) out separately - each becomes its
// own ERROR row, never silently absorbed into a group or dropped.
export function groupRows(rows: EnumeratedRow[]): { groups: RowGroup[]; malformed: EnumeratedRow[] } {
  const malformed = rows.filter((r) => !r.rawComplete);
  const complete = rows.filter((r) => r.rawComplete);
  const byAssignment = new Map<string, EnumeratedRow[]>();
  for (const row of complete) {
    const list = byAssignment.get(row.assignmentRef!) ?? [];
    list.push(row);
    byAssignment.set(row.assignmentRef!, list);
  }
  const groups = [...byAssignment.entries()].map(([assignmentRef, groupRows]) => ({ assignmentRef, rows: groupRows }));
  return { groups, malformed };
}

export function malformedRowResult(row: EnumeratedRow): ContentLinkRowResult {
  const missing: string[] = [];
  if (!row.assignmentRef) missing.push("Assignment Ref");
  if (!row.platform) missing.push("Platform");
  if (!row.url) missing.push("URL");
  return { sheetName: row.sheetName, sourceRowNumber: row.rowNumber, outcome: "ERROR", assignmentRef: row.assignmentRef, platform: row.platform, url: row.url, message: `Missing required column(s): ${missing.join(", ")}.`, contentRef: null };
}

// A REAL, read-only pre-check (never a guess) - the same Assignment-status and brief-platform rules
// recordContentLinksOnBehalf itself enforces, so a dry run's CREATE/AMBIGUOUS classification is honest,
// not a rubber stamp. Never mutates anything.
async function precheckGroup(group: RowGroup): Promise<{ ok: true } | { ok: false; message: string }> {
  const assignment = await getAssignmentDocByRef(group.assignmentRef);
  if (!assignment) return { ok: false, message: "Assignment Ref does not resolve to a real Assignment." };
  if (!ASSIGNMENT_STATES_ALLOWING_CONTENT_GENERATION.has(assignment.status)) return { ok: false, message: `Content links cannot be recorded while the Assignment is ${assignment.status}.` };
  const permitted = new Set(assignment.brief.platforms);
  const notPermitted = group.rows.map((r) => normalizePlatformIdentifier(r.platform!)).filter((p) => !permitted.has(p));
  if (notPermitted.length > 0) return { ok: false, message: `Platform(s) ${[...new Set(notPermitted)].join(", ")} are not permitted for this Assignment.` };
  return { ok: true };
}

function groupRowResult(row: EnumeratedRow, outcome: ContentLinkRowOutcome, message: string | null, contentRef: string | null): ContentLinkRowResult {
  return { sheetName: row.sheetName, sourceRowNumber: row.rowNumber, outcome, assignmentRef: row.assignmentRef, platform: row.platform, url: row.url, message, contentRef };
}

async function dryRunGroup(group: RowGroup, sourceHash: string): Promise<ContentLinkRowResult[]> {
  const claim = await getGroupClaim(groupClaimId(sourceHash, group.assignmentRef));
  if (claim) return group.rows.map((row) => groupRowResult(row, "UNCHANGED", "Already recorded by a previous run of this exact file.", claim.contentRef));

  const precheck = await precheckGroup(group);
  if (!precheck.ok) return group.rows.map((row) => groupRowResult(row, "AMBIGUOUS", precheck.message, null));

  return group.rows.map((row) => groupRowResult(row, "CREATE", null, null));
}

async function executeGroup(actor: ActorContext, group: RowGroup, sourceHash: string, requestId: string): Promise<ContentLinkRowResult[]> {
  const claimId = groupClaimId(sourceHash, group.assignmentRef);
  const claim = await getGroupClaim(claimId);
  if (claim) return group.rows.map((row) => groupRowResult(row, "UNCHANGED", "Already recorded by a previous run of this exact file.", claim.contentRef));

  const result = await recordContentLinksOnBehalf(
    actor,
    { assignmentRef: group.assignmentRef, rows: group.rows.map((row) => ({ platform: row.platform!, url: row.url! })) },
    requestId,
  );

  if (!result.ok) {
    const outcome: ContentLinkRowOutcome = result.code === "unauthorized" ? "AUTHORIZATION" : result.code === "not_found" ? "ERROR" : "AMBIGUOUS";
    return group.rows.map((row) => groupRowResult(row, outcome, result.message, null));
  }

  const now = new Date().toISOString();
  await contentLinkGroupClaimsCollection()
    .doc(claimId)
    .set(
      contentLinkGroupClaimDocSchema.parse({
        claimId,
        sourceHash,
        assignmentRef: group.assignmentRef,
        status: "COMPLETED",
        contentRef: result.data.contentRef,
        revisionNumber: result.data.currentRevisionNumber,
        claimedAt: now,
      } satisfies ContentLinkGroupClaimDoc),
    );

  return group.rows.map((row) => groupRowResult(row, "CREATE", null, result.data.contentRef));
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function parseAndGate(actor: ActorContext | null): Promise<void> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) throw new ImportAdapterError(classifyServiceErrorCode("unauthorized", "Import Center access denied."));
  const contentGate = await requireContentAccess(actor, "record_content_links");
  if (!contentGate.ok) throw new ImportAdapterError(classifyServiceErrorCode("unauthorized", "Content access denied."));
}

async function parseWorkbook(file: { buffer: Buffer; filename: string; mimeType: string }): Promise<{ sheets: ParsedSheet[]; sourceHash: string }> {
  const safety = checkImportFileSafety({ filename: file.filename, mimeType: file.mimeType, sizeBytes: file.buffer.byteLength, buffer: file.buffer });
  if (!safety.ok) throw new ImportAdapterError(classifyImportReasonCode(safety.reasonCode, safety.message));

  const parsed = parseWorkbookBuffer(file.buffer);
  if (!parsed.ok) throw new ImportAdapterError(classifyImportReasonCode(parsed.reasonCode, parsed.message));

  return { sheets: parsed.sheets, sourceHash: sha256Hex(file.buffer) };
}

function summarize(rows: ContentLinkRowResult[]) {
  const counts: Record<string, number> = { CREATE: 0, UNCHANGED: 0, AMBIGUOUS: 0, ERROR: 0, AUTHORIZATION: 0, QUARANTINED: 0 };
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}

function toGenericRows(rows: ContentLinkRowResult[]): ImportRowOutcomeSummary[] {
  return rows.map((row) => ({ sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, classification: row.outcome, outcome: row.outcome, identityLabel: row.assignmentRef, detail: row.message }));
}

// --- Batch provenance (bounded) --------------------------------------------
const MAX_STORED_ROWS = 500;

const contentLinkBatchDocSchema = z.object({
  uid: z.string().min(1),
  batchRef: z.string().min(1),
  sourceFilename: z.string().min(1).max(300),
  sourceHash: z.string().min(1).max(128),
  actorUserRef: z.string().min(1),
  createdAt: z.string().min(1),
  completedAt: z.string().min(1),
  status: z.enum(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]),
  totalRows: z.number().int().min(0),
  counts: z.record(z.string(), z.number().int().min(0)),
  rows: z
    .array(
      z.object({
        sheetName: z.string(),
        sourceRowNumber: z.number(),
        outcome: z.string(),
        assignmentRef: z.string().nullable(),
        platform: z.string().nullable(),
        message: z.string().nullable(),
        contentRef: z.string().nullable(),
      }),
    )
    .max(MAX_STORED_ROWS),
  rowsTruncated: z.boolean(),
});
export type ContentLinkBatchDoc = z.infer<typeof contentLinkBatchDocSchema>;
export type ContentLinkBatchListItemDto = ContentLinkBatchDoc & { actorDisplayName: string | null };

function contentLinkBatchesCollection() {
  return getAdminFirestore().collection("importContentLinkBatches");
}

async function withActorDisplayNames(docs: ContentLinkBatchDoc[]): Promise<ContentLinkBatchListItemDto[]> {
  const uniqueRefs = [...new Set(docs.map((d) => d.actorUserRef))];
  const entries = await Promise.all(uniqueRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const names = new Map(entries);
  return docs.map((d) => ({ ...d, actorDisplayName: names.get(d.actorUserRef) ?? null }));
}

export async function listContentLinkImportBatches(actor: ActorContext | null, limit = 20): Promise<{ ok: true; data: ContentLinkBatchListItemDto[] } | { ok: false; message: string }> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return { ok: false, message: "Import Center access denied." };
  const contentGate = await requireContentAccess(actor, "record_content_links");
  if (!contentGate.ok) return { ok: false, message: "Content access denied." };

  const snap = await contentLinkBatchesCollection().orderBy("createdAt", "desc").limit(Math.min(limit, 100)).get();
  const docs = snap.docs.map((d) => contentLinkBatchDocSchema.safeParse(d.data())).filter((r) => r.success).map((r) => (r as { success: true; data: ContentLinkBatchDoc }).data);
  return { ok: true, data: await withActorDisplayNames(docs) };
}

export async function getContentLinkImportBatchDetail(actor: ActorContext | null, batchRef: string): Promise<{ ok: true; data: ContentLinkBatchListItemDto } | { ok: false; message: string }> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return { ok: false, message: "Import Center access denied." };
  const contentGate = await requireContentAccess(actor, "record_content_links");
  if (!contentGate.ok) return { ok: false, message: "Content access denied." };

  const snap = await contentLinkBatchesCollection().where("batchRef", "==", batchRef).limit(1).get();
  if (snap.empty) return { ok: false, message: "Import batch not found." };
  const parsed = contentLinkBatchDocSchema.safeParse(snap.docs[0]!.data());
  if (!parsed.success) return { ok: false, message: "Import batch not found." };
  const [withName] = await withActorDisplayNames([parsed.data]);
  return { ok: true, data: withName! };
}

// --- Registration -----------------------------------------------------------
export function registerContentLinkImportTarget(): void {
  registerImportTarget({
    kind: "content_links",
    label: "Content links (record on the Partner's behalf)",
    dryRun: async (actor, file) => {
      await parseAndGate(actor);
      const { sheets, sourceHash } = await parseWorkbook(file);
      const enumerated = enumerateRows(sheets);
      const { groups, malformed } = groupRows(enumerated);

      const rows: ContentLinkRowResult[] = malformed.map(malformedRowResult);
      for (const group of groups) rows.push(...(await dryRunGroup(group, sourceHash)));
      rows.sort((a, b) => (a.sourceRowNumber === b.sourceRowNumber ? 0 : a.sourceRowNumber - b.sourceRowNumber));

      const counts = summarize(rows);
      return {
        batchRef: null,
        totalRows: rows.length,
        counts,
        safeErrorSummary: rows.filter((r) => r.outcome === "ERROR" && r.message).slice(0, 50).map((r) => `Row ${r.sourceRowNumber} (${r.sheetName}): ${r.message}`),
        sourceSheetInventory: sheets.map((s) => ({ sheetName: s.sheetName, rowCount: s.rows.length, recognizedAs: "content_links" })),
        rows: toGenericRows(rows).slice(0, 500),
        rowsTruncated: rows.length > 500,
      };
    },
    execute: async (actor, file, _options, requestId) => {
      await parseAndGate(actor);
      const { sheets, sourceHash } = await parseWorkbook(file);
      const enumerated = enumerateRows(sheets);
      const { groups, malformed } = groupRows(enumerated);

      const rows: ContentLinkRowResult[] = malformed.map(malformedRowResult);
      for (const group of groups) rows.push(...(await executeGroup(actor!, group, sourceHash, requestId)));
      rows.sort((a, b) => (a.sourceRowNumber === b.sourceRowNumber ? 0 : a.sourceRowNumber - b.sourceRowNumber));

      const counts = summarize(rows);
      const createdOrUnchanged = counts.CREATE + counts.UNCHANGED;
      const status: ContentLinkBatchDoc["status"] = rows.length === 0 || createdOrUnchanged === rows.length ? "COMPLETED" : createdOrUnchanged === 0 ? "FAILED" : "COMPLETED_WITH_ERRORS";

      const now = new Date().toISOString();
      const batchRef = randomUUID();
      const doc: ContentLinkBatchDoc = contentLinkBatchDocSchema.parse({
        uid: contentLinkBatchesCollection().doc().id,
        batchRef,
        sourceFilename: file.filename,
        sourceHash,
        actorUserRef: actor!.userRef,
        createdAt: now,
        completedAt: now,
        status,
        totalRows: rows.length,
        counts,
        rows: rows.slice(0, MAX_STORED_ROWS).map((r) => ({ sheetName: r.sheetName, sourceRowNumber: r.sourceRowNumber, outcome: r.outcome, assignmentRef: r.assignmentRef, platform: r.platform, message: r.message, contentRef: r.contentRef })),
        rowsTruncated: rows.length > MAX_STORED_ROWS,
      });
      await contentLinkBatchesCollection().doc(doc.uid).set(doc);

      return {
        batchRef,
        totalRows: rows.length,
        counts,
        safeErrorSummary: rows.filter((r) => r.outcome === "ERROR" && r.message).slice(0, 50).map((r) => `Row ${r.sourceRowNumber} (${r.sheetName}): ${r.message}`),
        sourceSheetInventory: sheets.map((s) => ({ sheetName: s.sheetName, rowCount: s.rows.length, recognizedAs: "content_links" })),
        rows: toGenericRows(rows).slice(0, 500),
        rowsTruncated: rows.length > 500,
        status,
      };
    },
  });
}

// Re-exported for the API route layer's classified-error mapping (mirrors contract-bundle-import.ts).
export { classifySystemError };
