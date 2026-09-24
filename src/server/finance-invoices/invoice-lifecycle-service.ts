import { canTransitionLifecycle, INVOICE_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getPayable } from "@/server/finance-payables";
import { getAdminFirestore } from "@/server/firebase/admin";

import type { InvoiceDetailDto } from "./client-dto";
import { getInvoiceVersionDoc, txCreateInvoiceVersion, txGetInvoiceHead, txGetInvoiceVersion, txSetInvoiceHead } from "./firestore";
import { loadAuthorizedInvoice, requireAmountsSensitiveAccess, requireAuthoringAccess, requireFinanceInvoicesAccess } from "./finance-invoices-gate";
import { appendInvoiceEvent } from "./invoice-events";
import { payeeIdentityApprovalBlocker } from "./payee-identity/matcher";
import type { PayeeIdentityOverallStatus } from "./payee-identity/types";
import { buildInvoiceDetailDto, scopeFieldsOf } from "./service-common";
import { compareInvoicePayableRevision, INVOICE_SOURCE_REVISION_MESSAGES, type CurrentPayableVersion } from "./source-revision";
import {
  acceptInvoiceMismatchInputSchema,
  financeInvoicesConflictResult,
  financeInvoicesInvalidInputResult,
  financeInvoicesNotFoundResult,
  financeInvoicesNotReadyResult,
  financeInvoicesStaleResult,
  financeInvoicesUnauthorizedResult,
  invoiceHeadDocSchema,
  rejectInvoiceInputSchema,
  reopenInvoiceInputSchema,
  approveInvoiceInputSchema,
  resolveInvoicePayeeMismatchInputSchema,
  submitInvoiceInputSchema,
  voidInvoiceInputSchema,
  type FinanceInvoicesErrorResult,
  type FinanceInvoicesReadinessIssue,
  type FinanceInvoicesServiceResult,
  type InvoiceHeadDoc,
  type InvoiceSourceCurrencyState,
} from "./types";

// Step 16A: the Invoice LIFECYCLE - submit, approve, reject, reopen, void, accept a mismatch - plus
// the read-only source-revision warning and the Payments-facing handoff contract. Mirrors Payables'
// own payable-lifecycle-service.ts.
//
// DRAFT -> SUBMITTED -> APPROVED | REJECTED. REJECTED can REOPEN back to a new DRAFT version under
// the SAME head (the rejected version is retained, never overwritten). VOID is reasoned and
// terminal for ordinary processing, reachable from every other state. There is no delete anywhere in
// this module.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string } | { kind: "not_ready"; message: string; blockers: FinanceInvoicesReadinessIssue[] };

function failureResult(failure: Failure): FinanceInvoicesErrorResult {
  if (failure.kind === "not_found") return financeInvoicesNotFoundResult();
  if (failure.kind === "stale") return financeInvoicesStaleResult();
  if (failure.kind === "not_ready") return financeInvoicesNotReadyResult(failure.message, failure.blockers);
  return financeInvoicesConflictResult(failure.message);
}

type OkResult = { kind: "ok"; head: InvoiceHeadDoc };

// --- SUBMIT ----------------------------------------------------------------------------------------------------------------
// Preconditions: DRAFT -> SUBMITTED only; the declared invoice number, date, currency and total are
// all present, and (this phase's product rule) the original document is attached. Ordinary edits are
// then blocked until the Invoice is approved, rejected, or reopened.
export const INVOICE_NOT_READY_CODES = {
  missingNumber: "invoice_missing_number",
  missingDate: "invoice_missing_date",
  missingCurrency: "invoice_missing_currency",
  missingTotal: "invoice_missing_total",
  missingDocument: "invoice_missing_document",
} as const;

export async function submitInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireFinanceInvoicesAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = submitInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "SUBMITTED", INVOICE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a draft invoice can be submitted." };
    if (!version) return { kind: "not_found" };

    const blockers: FinanceInvoicesReadinessIssue[] = [];
    if (version.externalInvoiceNumber === null) blockers.push({ code: INVOICE_NOT_READY_CODES.missingNumber, message: "The supplier invoice number is not set." });
    if (version.invoiceDate === null) blockers.push({ code: INVOICE_NOT_READY_CODES.missingDate, message: "The invoice date is not set." });
    if (version.currency === null) blockers.push({ code: INVOICE_NOT_READY_CODES.missingCurrency, message: "The invoice currency is not set." });
    if (version.declaredTotalMinor === null) blockers.push({ code: INVOICE_NOT_READY_CODES.missingTotal, message: "The declared total is not set." });
    if (version.document === null) blockers.push({ code: INVOICE_NOT_READY_CODES.missingDocument, message: "No original Invoice document has been attached yet." });
    if (blockers.length > 0) return { kind: "not_ready", message: "This invoice is not ready for submission.", blockers };

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "SUBMITTED",
      submittedVersion: version.version,
      submittedAt: now,
      submittedByUserRef: actor!.userRef,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_SUBMITTED",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "SUBMITTED", reconciliationState: version.reconciliation.state },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- APPROVE ----------------------------------------------------------------------------------------------------------------
// Preconditions: exact `approve_invoices` + `finance_amounts`; SUBMITTED only; the reconciliation
// computed for the submitted version has no unresolved BLOCKER finding other than a legitimate,
// explicitly ACCEPTED amount mismatch (section 16). Writes the exact approved version reference -
// no silent edits after this point.
export async function approveInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireAuthoringAccess(actor, "approve_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = approveInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "approve_invoices");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "APPROVED", INVOICE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a submitted invoice can be approved." };
    if (!version) return { kind: "not_found" };

    const blockers: FinanceInvoicesReadinessIssue[] = [];
    for (const finding of version.reconciliation.findings) {
      if (finding.severity !== "BLOCKER") continue;
      if (finding.code === "TOTAL_AMOUNT_MISMATCH") {
        const accepted = head.mismatchOverride !== null && head.mismatchOverride.forVersion === version.version;
        if (!accepted) blockers.push({ code: finding.code, message: "This invoice has an unresolved amount mismatch against its pinned Payable. Accept the mismatch with a reason before approving." });
        continue;
      }
      blockers.push({ code: finding.code, message: finding.message });
    }
    // Step 16C section 12: payee identity is evaluated SEPARATELY from the reconciliation findings
    // above (a distinct concept from an amount mismatch - never conflated with it) but gates
    // approval the same way: server-authoritative, never satisfied by UI button visibility alone.
    const payeeBlocker = payeeIdentityApprovalBlocker(version.payeeIdentity, head.payeeMismatchOverride, version.version);
    if (payeeBlocker) blockers.push(payeeBlocker);
    if (blockers.length > 0) return { kind: "not_ready", message: "This invoice cannot be approved yet.", blockers };

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "APPROVED",
      approvedVersion: version.version,
      approvedAt: now,
      approvedByUserRef: actor!.userRef,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_APPROVED",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "APPROVED", approvedVersion: version.version, reconciliationState: version.reconciliation.state },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- REJECT ----------------------------------------------------------------------------------------------------------------
// Requires a non-empty reason; SUBMITTED only; preserves the submitted version immutably.
export async function rejectInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireFinanceInvoicesAccess(actor, "approve_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = rejectInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "approve_invoices");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "REJECTED", INVOICE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a submitted invoice can be rejected." };

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "REJECTED",
      rejectedVersion: head.latestVersion,
      rejectedAt: now,
      rejectedByUserRef: actor!.userRef,
      rejectionReason: input.reason,
      mismatchOverride: null,
      payeeMismatchOverride: null,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_REJECTED",
      version: head.latestVersion,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "REJECTED", rejectedVersion: head.latestVersion, reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- REOPEN (revision after rejection) ---------------------------------------------------------------------------------------
// REJECTED -> DRAFT: creates a NEW immutable version (changeKind "reopened") that starts as an exact
// copy of the rejected version's declared content and document - the rejected version itself is
// retained, byte-identical, in history. Ordinary edits (reviseInvoiceDraft) resume from there. The
// invoice-number duplicate claim already names this head, so reopening is never treated as a second,
// duplicate external Invoice (section 14).
export async function reopenInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireFinanceInvoicesAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = reopenInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "DRAFT", INVOICE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a rejected invoice can be reopened." };
    const rejected = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);
    if (!rejected) return { kind: "not_found" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = { ...rejected, version: nextNumber, changeKind: "reopened" as const, reason: input.reason, createdAt: now, createdByUserRef: actor!.userRef };
    txCreateInvoiceVersion(tx, version);

    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "DRAFT",
      latestVersion: nextNumber,
      submittedVersion: null,
      submittedAt: null,
      submittedByUserRef: null,
      rejectedVersion: null,
      rejectedAt: null,
      rejectedByUserRef: null,
      rejectionReason: null,
      mismatchOverride: null,
      payeeMismatchOverride: null,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_REOPENED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "DRAFT", previousVersion: rejected.version, newVersion: nextNumber, changeKind: "reopened", reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- VOID ---------------------------------------------------------------------------------------------------------------------
// Terminal for ordinary processing and reasoned: nothing leaves VOID, a voided invoice can never be
// paid, and every historical version and event is retained.
export async function voidInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireFinanceInvoicesAccess(actor, "void_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = voidInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "void_invoices");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "VOID", INVOICE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "This invoice is already voided." };

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "VOID",
      voidedAt: now,
      voidedByUserRef: actor!.userRef,
      voidReason: input.reason,
      mismatchOverride: null,
      payeeMismatchOverride: null,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_VOIDED",
      version: head.latestVersion,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "VOID", version: head.latestVersion, reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- Accept a legitimate amount mismatch (section 16) --------------------------------------------------------------------------
// Only the exact `override_invoice_mismatch` action (Partnership Head / Super Admin in this phase's
// grants - never role rank) plus `finance_amounts`. Requires a reason, is audit-logged, preserves
// both the pinned Payable's expected amount and the Invoice's declared amount (neither is rewritten
// here or anywhere else), and is pinned to the EXACT version it was accepted for - a later revision
// clears it (see invoice-service.ts's reviseInvoiceDraft/attachInvoiceDocument, both of which reset
// `mismatchOverride` to null on the new version).
export async function acceptInvoiceMismatch(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireAuthoringAccess(actor, "override_invoice_mismatch");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = acceptInvoiceMismatchInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "override_invoice_mismatch");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status !== "SUBMITTED") return { kind: "conflict", message: "A mismatch can only be accepted on a submitted invoice, immediately before approval." };
    const version = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);
    if (!version) return { kind: "not_found" };
    if (!version.reconciliation.findings.some((finding) => finding.code === "TOTAL_AMOUNT_MISMATCH")) {
      return { kind: "conflict", message: "This invoice has no amount mismatch to accept." };
    }

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      mismatchOverride: { forVersion: version.version, reason: input.reason, actorUserRef: actor!.userRef, at: now },
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_MISMATCH_ACCEPTED",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { version: version.version, reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- Resolve a payee identity mismatch (Step 16C section 11) -----------------------------------------------------------------
// Only the exact `resolve_invoice_payee_mismatch` action (Partnership Head / Super Admin in this
// phase's grants - never role rank) plus `finance_amounts` (the same "you cannot resolve an issue in
// a record you may not see the amounts of" discipline as override_invoice_mismatch). Requires a
// reason, is audit-logged, and NEVER mutates the Payable's counterparty or any Partner/Vendor master
// data (section 11/19/20) - it only records that Finance accepts THIS Invoice as belonging to the
// expected Payable counterparty, pinned to the EXACT version it was accepted for. The original
// mismatch evidence (version.payeeIdentity) is never rewritten - see client-dto.ts's
// toInvoicePayeeIdentityDto for how "Accepted with reason" is shown alongside it, never in place of
// it (section 16).
export async function resolveInvoicePayeeMismatch(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireAuthoringAccess(actor, "resolve_invoice_payee_mismatch");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = resolveInvoicePayeeMismatchInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "resolve_invoice_payee_mismatch");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status !== "SUBMITTED") return { kind: "conflict", message: "A payee mismatch can only be resolved on a submitted invoice, immediately before approval." };
    const version = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);
    if (!version) return { kind: "not_found" };
    const blockingStatuses: PayeeIdentityOverallStatus[] = ["MISMATCH", "REVIEW_REQUIRED"];
    if (!version.payeeIdentity || !blockingStatuses.includes(version.payeeIdentity.overallStatus)) {
      return { kind: "conflict", message: "This invoice has no payee identity issue to resolve." };
    }

    const now = new Date().toISOString();
    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      payeeMismatchOverride: { forVersion: version.version, reason: input.reason, actorUserRef: actor!.userRef, at: now },
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_PAYEE_MISMATCH_ACCEPTED",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { version: version.version, reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, await getInvoiceVersionDoc(result.head.invoiceRef, result.head.latestVersion)) };
}

// --- Source-revision warning (read-only, section 15) -------------------------------------------------------------------------
export type InvoiceSourceRevisionDto = {
  invoiceRef: string;
  state: InvoiceSourceCurrencyState;
  message: string;
  pinnedPayableVersion: number;
  currentPayableVersion: number | null;
};

// Compares the invoice's PINNED Payable version against the Payable's CURRENT latest version. It
// never writes, never recalculates and never re-pins - there is no "adopt the newer Payable version"
// operation in this phase (section 15: "do not silently switch source"; nothing here does).
export async function getInvoiceSourceRevision(actor: ActorContext | null, invoiceRef: unknown): Promise<FinanceInvoicesServiceResult<InvoiceSourceRevisionDto>> {
  const loaded = await loadAuthorizedInvoice(actor, typeof invoiceRef === "string" ? invoiceRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;

  const version = await getInvoiceVersionDoc(head.invoiceRef, head.latestVersion);
  if (!version) return financeInvoicesNotFoundResult();

  const payable = await getPayable(actor, head.payableRef);
  const current: CurrentPayableVersion = payable.ok ? { latestVersion: payable.data.head.latestVersion, status: payable.data.head.status } : null;
  const comparison = compareInvoicePayableRevision({ payableVersion: version.payablePin.payableVersion }, current);
  const message = current === null ? "The pinned payable cannot be re-resolved right now, so no newer version is being offered. This invoice is unchanged." : INVOICE_SOURCE_REVISION_MESSAGES[comparison.state];

  return {
    ok: true,
    data: { invoiceRef: head.invoiceRef, state: comparison.state, message, pinnedPayableVersion: version.payablePin.payableVersion, currentPayableVersion: current?.latestVersion ?? null },
  };
}

// --- Payments-facing handoff contract (section 22) ---------------------------------------------------------------------------
// The ONLY Payments-facing output of this stage: a clean, read-only answer to exactly the questions
// section 22 names. No Payment record or lifecycle is created or referenced anywhere in this module.
export type InvoicePaymentHandoffDto = {
  invoiceRef: string;
  isApproved: boolean;
  approvedVersion: number | null;
  declaredTotalMinor: number | null;
  currency: string | null;
  payableRef: string;
  payableVersion: number;
  counterpartyType: string;
  counterpartyRef: string;
  isVoid: boolean;
  isRejected: boolean;
  hasUnresolvedBlockers: boolean;
  amountsVisible: boolean;
};

export async function getInvoicePaymentHandoff(actor: ActorContext | null, invoiceRef: unknown): Promise<FinanceInvoicesServiceResult<InvoicePaymentHandoffDto>> {
  const loaded = await loadAuthorizedInvoice(actor, typeof invoiceRef === "string" ? invoiceRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;

  const referenceVersionNumber = head.approvedVersion ?? head.latestVersion;
  const version = await getInvoiceVersionDoc(head.invoiceRef, referenceVersionNumber);
  if (!version) return financeInvoicesNotFoundResult();

  const amounts = await requireAmountsSensitiveAccess(actor!);
  const unresolvedBlockers = version.reconciliation.findings.some((finding) => finding.severity === "BLOCKER" && !(finding.code === "TOTAL_AMOUNT_MISMATCH" && head.mismatchOverride?.forVersion === version.version));

  return {
    ok: true,
    data: {
      invoiceRef: head.invoiceRef,
      isApproved: head.status === "APPROVED",
      approvedVersion: head.approvedVersion,
      declaredTotalMinor: amounts.ok ? version.declaredTotalMinor : null,
      currency: version.currency,
      payableRef: head.payableRef,
      payableVersion: version.payablePin.payableVersion,
      counterpartyType: head.counterpartyType,
      counterpartyRef: head.counterpartyRef,
      isVoid: head.status === "VOID",
      isRejected: head.status === "REJECTED",
      hasUnresolvedBlockers: unresolvedBlockers,
      amountsVisible: amounts.ok,
    },
  };
}
