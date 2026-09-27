import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { requireImportsModuleAccess } from "@/server/analytics/analytics-gate";
import { getUserDocByRef } from "@/server/authz/firestore";
import { parseWorkbookBuffer, type ParsedSheet } from "@/server/analytics/xlsx-parser";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { classifyImportReasonCode, classifyOnboardingBlockerCode, classifyServiceErrorCode, classifySystemError, type ImportErrorCategory } from "@/server/imports/error-taxonomy";
import { checkImportFileSafety } from "@/server/imports/file-safety";
import { ImportAdapterError, registerImportTarget, type ImportRowOutcomeSummary } from "@/server/imports/target-registry";
import { vendorTypeSchema } from "@/server/vendors/types";

import { requireFinanceAgreementsAccess } from "@/server/finance-agreements/finance-agreements-gate";
import { getOnboardingLedger, onboardingLedgerId } from "@/server/finance-agreements/onboarding-ledger";
import { normalizeProfile, onboardingInputSchema, type OnboardingInput } from "@/server/finance-agreements/onboarding-input";
import { createCounterpartyFromOnboarding, validateNewOnboarding } from "@/server/finance-agreements/onboarding-service";

// Import Center Completion (spec section 2B / 12): the CONTRACT-BUNDLE
// import adapter - a bulk spreadsheet of Partner/Vendor + one Partner
// Account + an Agreement-to-be, one row per bundle. This adapter parses
// and validates rows only; it creates NOTHING itself. Every actual
// mutation goes through the EXISTING, already-safe
// createCounterpartyFromOnboarding orchestration (Step 14B.1) - the same
// canonical Partner/Vendor/PartnerAccount/Agreement-draft services, the
// same live duplicate/scope checks, the same resumable step ledger, the
// same `createdVia: FINANCE_AGREEMENT_ONBOARDING` provenance a single
// Agreement-led onboarding uses. This file is deliberately thin: it maps
// spreadsheet rows to `OnboardingInput` and reports what the existing
// command decided - it does not reimplement counterparty creation,
// duplicate detection, or KYC handling.
//
// Deliberate, documented scope decisions for this stage (see the
// completion report for the reasoning):
//   - ONE Partner Account per row (a bundle needing several accounts on
//     the same Partner is out of scope for this stage; use the ordinary
//     Agreement-led onboarding UI for that case).
//   - NO restricted/KYC/payee-identity columns AT ALL. A sheet containing
//     any PAN/Aadhaar/GST/bank/IFSC/UPI/KYC-looking header is rejected
//     wholesale, file-level, before a single row is read - never
//     silently ignored. KYC continues to be captured afterward, per
//     Agreement, through the existing SecureKycDialog/trusted KYC
//     service - never through this bulk file path.
//   - No batch-level "resume" endpoint: each row's own onboarding ledger
//     is ALREADY a resumable step ledger (see onboarding-service.ts) - a
//     row that failed transiently resumes automatically the next time
//     this same bundle is executed (same clientRequestId), so a second,
//     bundle-specific resume mechanism would only duplicate that
//     orchestration.
//   - Ambiguous/duplicate rows are never force-created: they are
//     reported for the actor to resolve through the normal, interactive
//     Agreement-led onboarding screen (which can ask for the
//     acknowledgement + reason a STRONG duplicate needs) - a bulk import
//     never supplies `acknowledgedDuplicates` on the actor's behalf.

const RESTRICTED_HEADER_PATTERN = /\b(pan|aadhaar|adhaar|gstin?|bank|ifsc|upi|swift|iban|account\s*no|acct\s*no|passport|voter\s*id|kyc)\b/i;

const HEADER_ALIASES: Record<string, string[]> = {
  type: ["type", "counterparty type"],
  displayName: ["display name", "name", "partner name", "vendor name", "counterparty name"],
  legalName: ["legal name"],
  email: ["email", "email address"],
  phone: ["phone", "phone number", "contact number"],
  regionId: ["region", "region id", "regionid"],
  vendorType: ["vendor type"],
  platform: ["platform"],
  handle: ["handle", "username"],
  profileUrl: ["profile url", "page link", "account url"],
  platformAccountId: ["platform account id", "account id"],
  accountDisplayName: ["account display name", "page name", "channel name"],
};

// Exported for unit tests only (row parsing/restricted-column rejection/
// contract-bundle separation) - not part of the adapter's public runtime
// surface (that is registerContractBundleImportTarget, and the
// list/get history functions below).
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

export function findRestrictedHeaders(sheets: ParsedSheet[]): string[] {
  const hits = new Set<string>();
  for (const sheet of sheets) {
    for (const header of sheet.headers) {
      if (RESTRICTED_HEADER_PATTERN.test(header)) hits.add(header);
    }
  }
  return [...hits];
}

export function rowClientRequestId(sourceHash: string, sheetName: string, rowNumber: number): string {
  const hash = createHash("sha256").update(`${sourceHash}:${sheetName}:${rowNumber}`).digest("hex");
  return `bundle:${hash.slice(0, 40)}`;
}

export type ContractBundleRowOutcome = "CREATE" | "UNCHANGED" | "AMBIGUOUS" | "ERROR" | "AUTHORIZATION" | "QUARANTINED";

export type ContractBundleRowResult = {
  sheetName: string;
  sourceRowNumber: number;
  outcome: ContractBundleRowOutcome;
  category: ImportErrorCategory | null;
  displayName: string | null;
  counterpartyType: "PARTNER" | "VENDOR" | null;
  message: string | null;
  onboardingRef: string | null;
  counterpartyRef: string | null;
  agreementRef: string | null;
};

type RowBuildResult = { ok: true; clientRequestId: string; input: OnboardingInput } | { ok: false; row: ContractBundleRowResult };

export function buildRowInput(sheetName: string, rowNumber: number, raw: Record<string, string | undefined>, sourceHash: string, defaultRegionId: string | null): RowBuildResult {
  const errorRow = (message: string): RowBuildResult => ({
    ok: false,
    row: { sheetName, sourceRowNumber: rowNumber, outcome: "ERROR", category: "ROW", displayName: raw.displayName ?? null, counterpartyType: null, message, onboardingRef: null, counterpartyRef: null, agreementRef: null },
  });

  const typeRaw = (raw.type ?? "PARTNER").trim().toUpperCase();
  if (typeRaw !== "PARTNER" && typeRaw !== "VENDOR") return errorRow('The "Type" column must be "Partner" or "Vendor".');
  const type = typeRaw as "PARTNER" | "VENDOR";

  if (!raw.displayName) return errorRow("A display name is required.");

  const regionId = raw.regionId ?? defaultRegionId ?? undefined;
  if (!regionId) return errorRow('A region is required (a "Region" column, or a default region chosen for this import).');

  let vendorType: z.infer<typeof vendorTypeSchema> | undefined;
  if (type === "VENDOR") {
    const parsedType = vendorTypeSchema.safeParse((raw.vendorType ?? "").toUpperCase());
    if (!parsedType.success) return errorRow(`A Vendor row needs a valid "Vendor Type" column (one of: ${vendorTypeSchema.options.join(", ")}).`);
    vendorType = parsedType.data;
  } else if (raw.vendorType) {
    return errorRow('A "Vendor Type" applies to Vendor rows only.');
  }

  const hasAccountLocator = Boolean(raw.handle || raw.profileUrl || raw.platformAccountId);
  if (type === "VENDOR" && (raw.platform || hasAccountLocator)) return errorRow("A Vendor row has no Partner Account columns.");
  if (type === "PARTNER" && raw.platform && !hasAccountLocator) return errorRow("A Platform was given without a handle, profile URL, or platform account id.");

  const clientRequestId = rowClientRequestId(sourceHash, sheetName, rowNumber);
  const candidate = {
    clientRequestId,
    type,
    reviewedProfile: {
      displayName: raw.displayName,
      ...(raw.legalName ? { legalName: raw.legalName } : {}),
      ...(raw.email ? { email: raw.email } : {}),
      ...(raw.phone ? { phone: raw.phone } : {}),
      regionIds: [regionId],
      ...(vendorType ? { vendorType } : {}),
    },
    ...(type === "PARTNER" && raw.platform && hasAccountLocator
      ? { accounts: [{ platform: raw.platform, ...(raw.handle ? { handle: raw.handle } : {}), ...(raw.profileUrl ? { profileUrl: raw.profileUrl } : {}), ...(raw.platformAccountId ? { platformAccountId: raw.platformAccountId } : {}), ...(raw.accountDisplayName ? { displayName: raw.accountDisplayName } : {}) }] }
      : {}),
    duplicateDecision: { kind: "CREATE_NEW" as const, acknowledgedDuplicates: false },
  };

  const parsed = onboardingInputSchema.safeParse(candidate);
  if (!parsed.success) return errorRow(parsed.error.issues.map((i) => i.message).join("; "));
  return { ok: true, clientRequestId, input: parsed.data };
}

// --- Dry run (no mutation) --------------------------------------------------
async function dryRunRow(actor: ActorContext, sheetName: string, rowNumber: number, raw: Record<string, string | undefined>, sourceHash: string, defaultRegionId: string | null): Promise<ContractBundleRowResult> {
  const built = buildRowInput(sheetName, rowNumber, raw, sourceHash, defaultRegionId);
  if (!built.ok) return built.row;
  const { input, clientRequestId } = built;

  const existingLedger = await getOnboardingLedger(onboardingLedgerId(actor.uid, clientRequestId));
  if (existingLedger) {
    if (existingLedger.status === "COMPLETED") {
      return { sheetName, sourceRowNumber: rowNumber, outcome: "UNCHANGED", category: null, displayName: input.reviewedProfile.displayName, counterpartyType: input.type, message: "Already imported by a previous run of this exact file.", onboardingRef: existingLedger.onboardingRef, counterpartyRef: existingLedger.steps.counterparty?.ref ?? null, agreementRef: existingLedger.steps.agreement?.agreementRef ?? null };
    }
    return { sheetName, sourceRowNumber: rowNumber, outcome: "QUARANTINED", category: null, displayName: input.reviewedProfile.displayName, counterpartyType: input.type, message: "A previous run of this row did not finish - executing this bundle again will resume it.", onboardingRef: existingLedger.onboardingRef, counterpartyRef: null, agreementRef: null };
  }

  const profile = normalizeProfile(input.type, input.reviewedProfile);
  const blocked = await validateNewOnboarding(actor, input, profile, undefined);
  if (!blocked) {
    return { sheetName, sourceRowNumber: rowNumber, outcome: "CREATE", category: null, displayName: input.reviewedProfile.displayName, counterpartyType: input.type, message: null, onboardingRef: null, counterpartyRef: null, agreementRef: null };
  }

  const blockerCode = blocked.blockers?.[0]?.code ?? blocked.code;
  const classified = blocked.code === "unauthorized" ? classifyServiceErrorCode("unauthorized", blocked.message) : classifyOnboardingBlockerCode(blockerCode, blocked.message);
  return {
    sheetName,
    sourceRowNumber: rowNumber,
    outcome: classified.category === "AUTHORIZATION" ? "AUTHORIZATION" : "AMBIGUOUS",
    category: classified.category,
    displayName: input.reviewedProfile.displayName,
    counterpartyType: input.type,
    message: classified.message,
    onboardingRef: null,
    counterpartyRef: null,
    agreementRef: null,
  };
}

// --- Execute (server-authoritative - re-validates/re-authorizes every row via
// createCounterpartyFromOnboarding itself; a dry-run classification is
// NEVER trusted here, per spec section 8) --------------------------------
async function executeRow(actor: ActorContext, sheetName: string, rowNumber: number, raw: Record<string, string | undefined>, sourceHash: string, defaultRegionId: string | null, requestId: string): Promise<ContractBundleRowResult> {
  const built = buildRowInput(sheetName, rowNumber, raw, sourceHash, defaultRegionId);
  if (!built.ok) return built.row;
  const { input } = built;

  const result = await createCounterpartyFromOnboarding(actor, input, requestId);
  if (!result.ok) {
    const blockerCode = result.blockers?.[0]?.code ?? result.code;
    const classified = result.code === "unauthorized" ? classifyServiceErrorCode("unauthorized", result.message) : classifyOnboardingBlockerCode(blockerCode, result.message);
    return {
      sheetName,
      sourceRowNumber: rowNumber,
      outcome: classified.category === "AUTHORIZATION" ? "AUTHORIZATION" : "ERROR",
      category: classified.category,
      displayName: input.reviewedProfile.displayName,
      counterpartyType: input.type,
      message: classified.message,
      onboardingRef: null,
      counterpartyRef: null,
      agreementRef: null,
    };
  }

  const outcome = result.data;
  if (outcome.outcome === "COMPLETED") {
    return {
      sheetName,
      sourceRowNumber: rowNumber,
      outcome: outcome.replayed ? "UNCHANGED" : "CREATE",
      category: null,
      displayName: input.reviewedProfile.displayName,
      counterpartyType: input.type,
      message: null,
      onboardingRef: outcome.onboardingRef,
      counterpartyRef: outcome.counterparty?.ref ?? null,
      agreementRef: outcome.agreementRef,
    };
  }
  if (outcome.outcome === "IN_PROGRESS") {
    return { sheetName, sourceRowNumber: rowNumber, outcome: "QUARANTINED", category: null, displayName: input.reviewedProfile.displayName, counterpartyType: input.type, message: outcome.message, onboardingRef: outcome.onboardingRef, counterpartyRef: null, agreementRef: null };
  }
  // FAILED
  const failOutcome: ContractBundleRowOutcome = outcome.duplicateSignal ? "AMBIGUOUS" : outcome.retryable ? "QUARANTINED" : "ERROR";
  return { sheetName, sourceRowNumber: rowNumber, outcome: failOutcome, category: outcome.retryable ? null : "ROW", displayName: input.reviewedProfile.displayName, counterpartyType: input.type, message: outcome.message, onboardingRef: outcome.onboardingRef, counterpartyRef: null, agreementRef: null };
}

// --- Shared parse/rows enumeration ------------------------------------------
type EnumeratedRow = { sheetName: string; rowNumber: number; raw: Record<string, string | undefined> };

export function enumerateRows(sheets: ParsedSheet[]): EnumeratedRow[] {
  const out: EnumeratedRow[] = [];
  for (const sheet of sheets) {
    sheet.rows.forEach((row, index) => {
      const nonEmpty = Object.values(row).some((v) => v !== null && v !== undefined && String(v).trim().length > 0);
      if (!nonEmpty) return; // silently skip a wholly blank row (never a phantom "invalid" row for a trailing blank line)
      out.push({ sheetName: sheet.sheetName, rowNumber: index + 2, raw: resolveRow(row as Record<string, unknown>) });
    });
  }
  return out;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function parseAndGate(actor: ActorContext | null, file: { buffer: Buffer; filename: string; mimeType: string }): Promise<{ sheets: ParsedSheet[]; sourceHash: string } | never> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) throw new ImportAdapterError(classifyServiceErrorCode("unauthorized", "Import Center access denied."));
  const targetGate = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!targetGate.ok) throw new ImportAdapterError(classifyServiceErrorCode("unauthorized", "Finance Agreements access denied."));

  const safety = checkImportFileSafety({ filename: file.filename, mimeType: file.mimeType, sizeBytes: file.buffer.byteLength, buffer: file.buffer });
  if (!safety.ok) throw new ImportAdapterError(classifyImportReasonCode(safety.reasonCode, safety.message));

  const parsed = parseWorkbookBuffer(file.buffer);
  if (!parsed.ok) throw new ImportAdapterError(classifyImportReasonCode(parsed.reasonCode, parsed.message));

  const restricted = findRestrictedHeaders(parsed.sheets);
  if (restricted.length > 0) {
    throw new ImportAdapterError(
      classifyImportReasonCode("RESTRICTED_FIELD_REJECTED", `This file contains column(s) that look like restricted payee/KYC data (${restricted.join(", ")}) and cannot be imported this way. Remove these columns - identity/KYC details are captured separately, per Agreement, through the secure KYC flow.`),
    );
  }
  return { sheets: parsed.sheets, sourceHash: sha256Hex(file.buffer) };
}

function summarize(rows: ContractBundleRowResult[]) {
  const counts: Record<string, number> = { CREATE: 0, UNCHANGED: 0, AMBIGUOUS: 0, ERROR: 0, AUTHORIZATION: 0, QUARANTINED: 0 };
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}

function toGenericRows(rows: ContractBundleRowResult[]): ImportRowOutcomeSummary[] {
  return rows.map((row) => ({ sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, classification: row.outcome, outcome: row.outcome, identityLabel: row.displayName, detail: row.message }));
}

// --- Batch provenance (bounded, no restricted values ever stored) ---------
const MAX_STORED_ROWS = 500;

const contractBundleBatchDocSchema = z.object({
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
        displayName: z.string().nullable(),
        counterpartyType: z.string().nullable(),
        message: z.string().nullable(),
        onboardingRef: z.string().nullable(),
        counterpartyRef: z.string().nullable(),
        agreementRef: z.string().nullable(),
      }),
    )
    .max(MAX_STORED_ROWS),
  rowsTruncated: z.boolean(),
});
export type ContractBundleBatchDoc = z.infer<typeof contractBundleBatchDocSchema>;
export type ContractBundleBatchListItemDto = ContractBundleBatchDoc & { actorDisplayName: string | null };

function contractBundleBatchesCollection() {
  return getAdminFirestore().collection("importContractBundleBatches");
}

// Never a raw uid as the primary actor label (spec section 10/11) -
// resolved to a safe display name on read, same pattern as Analytics's
// own import-history-service.ts.
async function withActorDisplayNames(docs: ContractBundleBatchDoc[]): Promise<ContractBundleBatchListItemDto[]> {
  const uniqueRefs = [...new Set(docs.map((d) => d.actorUserRef))];
  const entries = await Promise.all(uniqueRefs.map(async (ref) => [ref, (await getUserDocByRef(ref))?.displayName ?? null] as const));
  const names = new Map(entries);
  return docs.map((d) => ({ ...d, actorDisplayName: names.get(d.actorUserRef) ?? null }));
}

export async function listContractBundleImportBatches(actor: ActorContext | null, limit = 20): Promise<{ ok: true; data: ContractBundleBatchListItemDto[] } | { ok: false; message: string }> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return { ok: false, message: "Import Center access denied." };
  const targetGate = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!targetGate.ok) return { ok: false, message: "Finance Agreements access denied." };

  const snap = await contractBundleBatchesCollection().orderBy("createdAt", "desc").limit(Math.min(limit, 100)).get();
  const docs = snap.docs.map((d) => contractBundleBatchDocSchema.safeParse(d.data())).filter((r) => r.success).map((r) => (r as { success: true; data: ContractBundleBatchDoc }).data);
  return { ok: true, data: await withActorDisplayNames(docs) };
}

export async function getContractBundleImportBatchDetail(actor: ActorContext | null, batchRef: string): Promise<{ ok: true; data: ContractBundleBatchListItemDto } | { ok: false; message: string }> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return { ok: false, message: "Import Center access denied." };
  const targetGate = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!targetGate.ok) return { ok: false, message: "Finance Agreements access denied." };

  const snap = await contractBundleBatchesCollection().where("batchRef", "==", batchRef).limit(1).get();
  if (snap.empty) return { ok: false, message: "Import batch not found." };
  const parsed = contractBundleBatchDocSchema.safeParse(snap.docs[0]!.data());
  if (!parsed.success) return { ok: false, message: "Import batch not found." };
  const [withName] = await withActorDisplayNames([parsed.data]);
  return { ok: true, data: withName! };
}

// --- Registration ------------------------------------------------------
export function registerContractBundleImportTarget(): void {
  registerImportTarget({
    kind: "contract_bundle",
    label: "Contract bundle (Partner/Vendor + Agreement)",
    dryRun: async (actor, file, options) => {
      const { sheets, sourceHash } = await parseAndGate(actor, file);
      const defaultRegionId = typeof (options as Record<string, unknown>).defaultRegionId === "string" ? ((options as Record<string, unknown>).defaultRegionId as string) : null;
      const enumerated = enumerateRows(sheets);
      const rows: ContractBundleRowResult[] = [];
      for (const row of enumerated) rows.push(await dryRunRow(actor!, row.sheetName, row.rowNumber, row.raw, sourceHash, defaultRegionId));
      const counts = summarize(rows);
      return {
        batchRef: null,
        totalRows: rows.length,
        counts,
        safeErrorSummary: rows.filter((r) => r.outcome === "ERROR" && r.message).slice(0, 50).map((r) => `Row ${r.sourceRowNumber} (${r.sheetName}): ${r.message}`),
        sourceSheetInventory: sheets.map((s) => ({ sheetName: s.sheetName, rowCount: s.rows.length, recognizedAs: "contract_bundle" })),
        rows: toGenericRows(rows).slice(0, 500),
        rowsTruncated: rows.length > 500,
      };
    },
    execute: async (actor, file, options, requestId) => {
      const { sheets, sourceHash } = await parseAndGate(actor, file);
      const defaultRegionId = typeof (options as Record<string, unknown>).defaultRegionId === "string" ? ((options as Record<string, unknown>).defaultRegionId as string) : null;
      const enumerated = enumerateRows(sheets);
      const rows: ContractBundleRowResult[] = [];
      for (const row of enumerated) rows.push(await executeRow(actor!, row.sheetName, row.rowNumber, row.raw, sourceHash, defaultRegionId, requestId));
      const counts = summarize(rows);

      const createdOrUnchanged = counts.CREATE + counts.UNCHANGED;
      const status: ContractBundleBatchDoc["status"] = rows.length === 0 || createdOrUnchanged === rows.length ? "COMPLETED" : createdOrUnchanged === 0 ? "FAILED" : "COMPLETED_WITH_ERRORS";

      const now = new Date().toISOString();
      const batchRef = randomUUID();
      const doc: ContractBundleBatchDoc = contractBundleBatchDocSchema.parse({
        uid: contractBundleBatchesCollection().doc().id,
        batchRef,
        sourceFilename: file.filename,
        sourceHash,
        actorUserRef: actor!.userRef,
        createdAt: now,
        completedAt: now,
        status,
        totalRows: rows.length,
        counts,
        rows: rows.slice(0, MAX_STORED_ROWS),
        rowsTruncated: rows.length > MAX_STORED_ROWS,
      });
      await contractBundleBatchesCollection().doc(doc.uid).set(doc);

      return {
        batchRef,
        totalRows: rows.length,
        counts,
        safeErrorSummary: rows.filter((r) => r.outcome === "ERROR" && r.message).slice(0, 50).map((r) => `Row ${r.sourceRowNumber} (${r.sheetName}): ${r.message}`),
        sourceSheetInventory: sheets.map((s) => ({ sheetName: s.sheetName, rowCount: s.rows.length, recognizedAs: "contract_bundle" })),
        rows: toGenericRows(rows).slice(0, 500),
        rowsTruncated: rows.length > 500,
        status,
      };
    },
  });
}

// Re-exported for the API route layer's classified-error mapping.
export { classifySystemError };
