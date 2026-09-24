import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getPayable } from "@/server/finance-payables";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toInvoiceEventDto, toInvoicePayablePinDto, toInvoiceVersionDto, type InvoiceDetailDto, type InvoiceDocumentDto, type InvoiceEventDto, type InvoicePayablePinDto, type InvoiceVersionDto } from "./client-dto";
import {
  DEFAULT_INVOICE_EVENT_PAGE,
  MAX_INVOICE_EVENT_PAGE,
  getInvoiceHeadDoc,
  getInvoiceNumberClaimDoc,
  getInvoiceVersionDoc,
  listInvoiceEventDocs,
  txCreateInvoiceHead,
  txCreateInvoiceNumberClaim,
  txCreateInvoiceVersion,
  txGetInvoiceHead,
  txGetInvoiceNumberClaim,
  txGetInvoiceVersion,
  txInvoiceHeadExists,
  txSetInvoiceHead,
} from "./firestore";
import { loadAuthorizedInvoice, loadAuthorizedInvoiceCounterparty, requireAmountsSensitiveAccess, requireAuthoringAccess } from "./finance-invoices-gate";
import { INVOICE_DOCUMENT_MIME_TYPE, getInvoiceDocumentStorage, sha256Hex, validateInvoicePdf } from "./document-storage";
import { invoiceDocumentIdempotencyKey, invoiceNumberClaimId, invoiceRefFor, normalizeInvoiceNumber } from "./ids";
import { appendInvoiceEvent } from "./invoice-events";
import { resolveInvoicePayableSource, type InvoicePayableBlocker } from "./payable-source";
import { resolveAndComparePayeeIdentity } from "./payee-identity/resolve-identity";
import { reconcileInvoiceAgainstPayable } from "./reconciliation";
import { buildInvoiceDetailDto, buildInvoiceHeadDisplay, formatIssues, isAlreadyExistsError, scopeFieldsOf } from "./service-common";
import {
  attachInvoiceDocumentInputSchema,
  createInvoiceDraftInputSchema,
  financeInvoicesConflictResult,
  financeInvoicesInvalidInputResult,
  financeInvoicesNotFoundResult,
  financeInvoicesNotReadyResult,
  financeInvoicesStaleResult,
  financeInvoicesUnauthorizedResult,
  invoiceHeadDocSchema,
  invoiceVersionDocSchema,
  MAX_INVOICE_VERSIONS,
  previewInvoiceEligibilityInputSchema,
  reconcileInvoiceInputSchema,
  reviseInvoiceDraftInputSchema,
  type FinanceInvoicesErrorResult,
  type FinanceInvoicesServiceResult,
  type InvoiceHeadDoc,
  type InvoiceTaxLine,
  type InvoiceVersionDoc,
} from "./types";

// Step 16A: the trusted Finance Invoices service - preview, idempotent create, reads, DRAFT
// revision and document attach. The lifecycle transitions (submit/approve/reject/reopen/void/accept
// mismatch) live in invoice-lifecycle-service.ts.
//
// Every command runs the gate chain (Authentication -> Admission -> FeatureAccess(finance) ->
// ActionPermission -> live RecordScope -> lifecycle preconditions inside the transaction), writes
// ONLY financeInvoices*/financeInvoiceNumberClaims documents, appends its audit event(s) in the SAME
// transaction, and never writes a Payable, an Agreement, a Partner Review, a Partner, a Vendor or a
// Payment record.
//
// VERSIONS ARE IMMUTABLE. Every change - a revision, a document attach - tx.creates the NEXT
// version and leaves every earlier one byte-identical.

// --- Preview (read-only) ------------------------------------------------------------------------------------------------------
export type PreviewInvoiceEligibilityDto = {
  payableRef: string;
  eligible: boolean;
  blockers: InvoicePayableBlocker[];
  pin: InvoicePayablePinDto | null;
  counterpartyDisplayName: string | null;
  existingInvoiceRef: string | null;
  amountsVisible: boolean;
};

// "Would a Payable found an Invoice, and if so what would be pinned?" Resolves the Payable's
// published contract WITHOUT writing anything. Needs the same authoring access as creating one (a
// preview reveals the same pinned figures a created Invoice would).
export async function previewInvoiceEligibility(actor: ActorContext | null, rawInput: unknown): Promise<FinanceInvoicesServiceResult<PreviewInvoiceEligibilityDto>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = previewInvoiceEligibilityInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));

  const amountsVisible = (await requireAmountsSensitiveAccess(actor!)).ok;
  const source = await resolveInvoicePayableSource(actor!, parsed.data.payableRef);
  const invoiceRef = invoiceRefFor(parsed.data.payableRef);
  const existingHead = await getInvoiceHeadDoc(invoiceRef);

  if (!source.ok) {
    return { ok: true, data: { payableRef: parsed.data.payableRef, eligible: false, blockers: source.blockers, pin: null, counterpartyDisplayName: null, existingInvoiceRef: existingHead ? invoiceRef : null, amountsVisible } };
  }

  return {
    ok: true,
    data: {
      payableRef: parsed.data.payableRef,
      eligible: true,
      blockers: [],
      pin: toInvoicePayablePinDto(source.resolved.pin, { amountsVisible }),
      counterpartyDisplayName: source.resolved.counterpartyDisplayName,
      existingInvoiceRef: existingHead ? invoiceRef : null,
      amountsVisible,
    },
  };
}

// --- Create (idempotent) --------------------------------------------------------------------------------------------------------
export type CreateInvoiceOutcome = { outcome: "created" | "existing"; invoice: InvoiceDetailDto };

// Creates the canonical Invoice for one Payable: the head plus IMMUTABLE version 1 (fully
// undeclared - no supplier invoice number, no document, no amounts yet).
//
// IDEMPOTENT BY CONSTRUCTION. `invoiceRef` is DETERMINISTIC in payableRef (invoiceRefFor), so it IS
// the document id: a retried or concurrent create for the same Payable can only ever resolve to the
// ONE head (the loser's tx.create fails with ALREADY_EXISTS and hands back the winner's Invoice).
// An "already-used Payable" (section 7) therefore can never create a second, independent Invoice
// head - it always resolves to the same canonical one.
export async function createInvoiceDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<CreateInvoiceOutcome>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = createInvoiceDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));

  const invoiceRef = invoiceRefFor(parsed.data.payableRef);
  const existingHead = await getInvoiceHeadDoc(invoiceRef);
  if (existingHead) return resolveExistingInvoice(actor!, invoiceRef);

  const source = await resolveInvoicePayableSource(actor!, parsed.data.payableRef);
  if (!source.ok) return financeInvoicesNotReadyResult("This invoice cannot be created from the named payable.", source.blockers);
  const { pin, counterpartyDisplayName } = source.resolved;

  // Step 16C: a DRAFT starts with no extracted payee evidence - the comparison still runs (against
  // the Payable-pinned counterparty ONLY, section 3/20), so an empty draft's payee identity reads
  // INSUFFICIENT_EVIDENCE/PARTIAL_MATCH rather than null, matching every later version's shape.
  const payeeIdentity = await resolveAndComparePayeeIdentity({ counterpartyType: pin.counterpartyType, counterpartyRef: pin.counterpartyRef, extractedPayeeName: null });

  type CreateTxResult = { kind: "created"; head: InvoiceHeadDoc; version: InvoiceVersionDoc } | { kind: "existing" };

  let txResult: CreateTxResult;
  try {
    txResult = await getAdminFirestore().runTransaction<CreateTxResult>(async (tx) => {
      if (await txInvoiceHeadExists(tx, invoiceRef)) return { kind: "existing" };

      const now = new Date().toISOString();
      const reconciliation = reconcileInvoiceAgainstPayable(
        { declared: emptyDeclared(pin), pin, documentPresent: false, documentRequired: true, duplicateNumberDetected: false },
        () => new Date(now),
      );
      const version = invoiceVersionDocSchema.parse({
        invoiceRef,
        version: 1,
        payablePin: pin,
        externalInvoiceNumber: null,
        normalizedInvoiceNumberKey: null,
        invoiceDate: null,
        receivedDate: null,
        currency: null,
        subtotalMinor: null,
        taxLines: [],
        declaredTotalMinor: null,
        dueDate: null,
        document: null,
        reconciliation,
        extractedPayeeName: null,
        payeeIdentity,
        changeKind: "created",
        reason: null,
        createdAt: now,
        createdByUserRef: actor!.userRef,
      });

      const head: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
        invoiceRef,
        docVersion: 1,
        payableRef: pin.payableRef,
        counterpartyType: pin.counterpartyType,
        counterpartyRef: pin.counterpartyRef,
        periodKey: pin.commercialPeriod.periodKey,
        periodStart: pin.commercialPeriod.periodStart,
        periodEnd: pin.commercialPeriod.periodEnd,
        currency: null,
        externalInvoiceNumber: null,
        normalizedInvoiceNumberKey: null,
        ...(await scopeOf(actor!, pin.counterpartyType, pin.counterpartyRef)),
        status: "DRAFT",
        latestVersion: 1,
        display: buildInvoiceHeadDisplay({ counterpartyName: counterpartyDisplayName, version, projectedAt: now }),
        createdAt: now,
        createdByUserRef: actor!.userRef,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      });

      txCreateInvoiceHead(tx, head);
      txCreateInvoiceVersion(tx, version);
      appendInvoiceEvent(tx, {
        invoiceRef,
        kind: "INVOICE_CREATED",
        version: 1,
        actorUserRef: actor!.userRef,
        metadata: { payableRef: pin.payableRef, payableVersion: pin.payableVersion, counterpartyType: pin.counterpartyType, counterpartyRef: pin.counterpartyRef },
        requestId,
        createdAt: now,
      });
      appendInvoiceEvent(tx, { invoiceRef, kind: "INVOICE_VERSION_CREATED", version: 1, actorUserRef: actor!.userRef, metadata: { version: 1, changeKind: "created" }, requestId, createdAt: now });
      appendInvoiceEvent(tx, { invoiceRef, kind: "INVOICE_PAYEE_IDENTITY_CHECKED", version: 1, actorUserRef: actor!.userRef, metadata: { version: 1, payeeIdentityStatus: payeeIdentity.overallStatus }, requestId, createdAt: now });
      return { kind: "created", head, version };
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return resolveExistingInvoice(actor!, invoiceRef);
  }

  if (txResult.kind === "existing") return resolveExistingInvoice(actor!, invoiceRef);
  return { ok: true, data: { outcome: "created", invoice: await buildInvoiceDetailDto(actor!, txResult.head, counterpartyDisplayName, txResult.version) } };
}

// The Payable's own resolved counterparty display name is already known from resolveInvoicePayableSource,
// but its SCOPE snapshot is Payables' own private concern - Invoices re-derive their own live scope
// the same way Payables does, from the same Partner/Vendor modules.
async function scopeOf(actor: ActorContext, counterpartyType: "PARTNER" | "VENDOR", counterpartyRef: string) {
  const loaded = await loadAuthorizedInvoiceCounterparty(actor, counterpartyType, counterpartyRef);
  if (!loaded.ok) throw new Error("Invoice counterparty scope could not be resolved after eligibility already confirmed it.");
  return scopeFieldsOf(loaded.authorized.scope);
}

function emptyDeclared(pin: { counterpartyType: "PARTNER" | "VENDOR"; counterpartyRef: string; commercialPeriod: { periodKey: string; periodStart: string; periodEnd: string } }) {
  return {
    currency: null,
    subtotalMinor: null,
    taxLines: [] as InvoiceTaxLine[],
    declaredTotalMinor: null,
    externalInvoiceNumber: null,
    counterpartyType: pin.counterpartyType,
    counterpartyRef: pin.counterpartyRef,
    commercialPeriod: pin.commercialPeriod,
  };
}

async function resolveExistingInvoice(actor: ActorContext, invoiceRef: string): Promise<FinanceInvoicesServiceResult<CreateInvoiceOutcome>> {
  const loaded = await loadAuthorizedInvoice(actor, invoiceRef);
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;
  const version = await getInvoiceVersionDoc(head.invoiceRef, head.latestVersion);
  return { ok: true, data: { outcome: "existing", invoice: await buildInvoiceDetailDto(actor, head, displayName, version) } };
}

// --- Reads -----------------------------------------------------------------------------------------------------------------------
const versionNumberSchema = z.number().int().min(1);

export async function getInvoice(actor: ActorContext | null, invoiceRef: unknown, input: { version?: unknown } = {}): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const loaded = await loadAuthorizedInvoice(actor, typeof invoiceRef === "string" ? invoiceRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;

  let versionNumber = head.latestVersion;
  if (input.version !== undefined) {
    const parsedVersion = versionNumberSchema.safeParse(input.version);
    if (!parsedVersion.success) return financeInvoicesInvalidInputResult("version must be a positive integer.");
    versionNumber = parsedVersion.data;
  }
  const version = await getInvoiceVersionDoc(head.invoiceRef, versionNumber);
  if (!version) return financeInvoicesNotFoundResult();
  return { ok: true, data: await buildInvoiceDetailDto(actor!, head, displayName, version) };
}

const eventLimitSchema = z.number().int().min(1).max(MAX_INVOICE_EVENT_PAGE);

export async function listInvoiceEvents(
  actor: ActorContext | null,
  invoiceRef: unknown,
  input: { limit?: unknown } = {},
): Promise<FinanceInvoicesServiceResult<{ invoiceRef: string; events: InvoiceEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedInvoice(actor, typeof invoiceRef === "string" ? invoiceRef : "");
  if (!loaded.ok) return loaded.error;
  let limit = DEFAULT_INVOICE_EVENT_PAGE;
  if (input.limit !== undefined) {
    const parsedLimit = eventLimitSchema.safeParse(input.limit);
    if (!parsedLimit.success) return financeInvoicesInvalidInputResult(`limit must be an integer between 1 and ${MAX_INVOICE_EVENT_PAGE}.`);
    limit = parsedLimit.data;
  }
  const listed = await listInvoiceEventDocs(loaded.authorized.head.invoiceRef, limit);
  return { ok: true, data: { invoiceRef: loaded.authorized.head.invoiceRef, events: listed.events.map(toInvoiceEventDto), hasMore: listed.hasMore } };
}

// --- DRAFT revision --------------------------------------------------------------------------------------------------------------
type MutationFailure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

function mutationFailureResult(failure: MutationFailure): FinanceInvoicesErrorResult {
  if (failure.kind === "not_found") return financeInvoicesNotFoundResult();
  if (failure.kind === "stale") return financeInvoicesStaleResult();
  return financeInvoicesConflictResult(failure.message);
}

type VersionTxResult = { kind: "ok"; head: InvoiceHeadDoc; version: InvoiceVersionDoc } | MutationFailure;

function checkDraftRevisable(head: InvoiceHeadDoc | null, expectedDocVersion: number): MutationFailure | null {
  if (!head) return { kind: "not_found" };
  if (head.docVersion !== expectedDocVersion) return { kind: "stale" };
  if (head.status !== "DRAFT") return { kind: "conflict", message: "This invoice is not a draft, so it cannot be edited directly. Submitted invoices are read-only until approved, rejected or reopened." };
  if (head.latestVersion >= MAX_INVOICE_VERSIONS) return { kind: "conflict", message: "This invoice has reached its maximum number of versions." };
  return null;
}

// Resolves the invoice-number DUPLICATE claim (section 6) inside the caller's transaction:
//   - no number declared -> nothing to claim, nothing changes;
//   - a number is declared and no claim exists for it -> claim it for THIS head;
//   - a number is declared and the claim already names THIS head -> fine, unchanged (a revision
//     under the same head reusing/re-declaring its own number is never a duplicate of itself);
//   - a number is declared and the claim names a DIFFERENT head -> hard conflict, nothing is
//     written (a genuine duplicate is never silently persisted).
async function claimInvoiceNumberInTx(
  tx: FirebaseFirestore.Transaction,
  invoiceRef: string,
  counterpartyType: "PARTNER" | "VENDOR",
  counterpartyRef: string,
  normalizedNumber: string | null,
  now: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (normalizedNumber === null) return { ok: true };
  const claimId = invoiceNumberClaimId(counterpartyType, counterpartyRef, normalizedNumber);
  const existing = await txGetInvoiceNumberClaim(tx, claimId);
  if (existing) {
    if (existing.invoiceRef !== invoiceRef) return { ok: false, message: "This supplier invoice number is already used by a different Invoice for this counterparty. Correct the number, or resolve the other Invoice first." };
    return { ok: true };
  }
  txCreateInvoiceNumberClaim(tx, claimId, { claimId, invoiceRef, counterpartyType, counterpartyRef, createdAt: now });
  return { ok: true };
}

// Updates the declared fields of a DRAFT (an omitted field KEEPS its previous value; an explicit
// `null` clears it), recomputes reconciliation, and appends the NEXT immutable version. Never
// mutates a prior version; never touches the Payable it pins.
export async function reviseInvoiceDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = reviseInvoiceDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  const { head: currentHead, displayName, liveScope } = loaded.authorized;
  if (currentHead.status !== "DRAFT") return financeInvoicesConflictResult("This invoice is not a draft, so it cannot be edited directly.");

  const previous = await getInvoiceVersionDoc(currentHead.invoiceRef, currentHead.latestVersion);
  if (!previous) return financeInvoicesNotFoundResult();

  const externalInvoiceNumber = input.externalInvoiceNumber === undefined ? previous.externalInvoiceNumber : input.externalInvoiceNumber;
  const normalizedInvoiceNumberKey = externalInvoiceNumber === null ? null : normalizeInvoiceNumber(externalInvoiceNumber);
  const taxLines: InvoiceTaxLine[] = input.taxLines === undefined ? previous.taxLines : input.taxLines;

  const declared = {
    currency: input.currency === undefined ? previous.currency : input.currency,
    subtotalMinor: input.subtotalMinor === undefined ? previous.subtotalMinor : input.subtotalMinor,
    taxLines,
    declaredTotalMinor: input.declaredTotalMinor === undefined ? previous.declaredTotalMinor : input.declaredTotalMinor,
    externalInvoiceNumber,
    counterpartyType: previous.payablePin.counterpartyType,
    counterpartyRef: previous.payablePin.counterpartyRef,
    commercialPeriod: previous.payablePin.commercialPeriod,
  };

  // Best-effort, read-only awareness (section 15): does a NEWER Payable version now exist than the
  // one this Invoice pins? This NEVER re-pins anything (the pin above is copied verbatim from
  // `previous`) - it only decides whether to append an informational PAYABLE_REVISION_DETECTED
  // audit event alongside this revision, exactly the same "detect, never silently adopt" discipline
  // Payables applies to its own upstream Agreement/Review revisions.
  const livePayable = await getPayable(actor!, previous.payablePin.payableRef);
  const payableRevisionDetected = livePayable.ok && livePayable.data.head.latestVersion !== previous.payablePin.payableVersion;

  // Step 16C section 13: EVERY revision recomputes a fresh payee identity result for the NEW
  // version - an earlier version's result is never touched. The client applies an extraction
  // proposal into `extractedPayeeName` exactly like any other declared field (omitted = keep,
  // explicit null = clear).
  const extractedPayeeName = input.extractedPayeeName === undefined ? previous.extractedPayeeName : input.extractedPayeeName;
  const payeeIdentity = await resolveAndComparePayeeIdentity({ counterpartyType: previous.payablePin.counterpartyType, counterpartyRef: previous.payablePin.counterpartyRef, extractedPayeeName });

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    const failure = checkDraftRevisable(head, input.expectedDocVersion);
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const latest = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);
    if (!latest || latest.version !== previous.version) return { kind: "stale" };

    const now = new Date().toISOString();
    const claimed = await claimInvoiceNumberInTx(tx, head.invoiceRef, head.counterpartyType, head.counterpartyRef, normalizedInvoiceNumberKey, now);
    if (!claimed.ok) return { kind: "conflict", message: claimed.message };

    const reconciliation = reconcileInvoiceAgainstPayable({ declared, pin: previous.payablePin, documentPresent: previous.document !== null, documentRequired: true, duplicateNumberDetected: false }, () => new Date(now));

    const nextNumber = head.latestVersion + 1;
    const version = invoiceVersionDocSchema.parse({
      invoiceRef: head.invoiceRef,
      version: nextNumber,
      payablePin: previous.payablePin,
      externalInvoiceNumber,
      normalizedInvoiceNumberKey,
      invoiceDate: input.invoiceDate === undefined ? previous.invoiceDate : input.invoiceDate,
      receivedDate: input.receivedDate === undefined ? previous.receivedDate : input.receivedDate,
      currency: declared.currency,
      subtotalMinor: declared.subtotalMinor,
      taxLines: declared.taxLines,
      declaredTotalMinor: declared.declaredTotalMinor,
      dueDate: input.dueDate === undefined ? previous.dueDate : input.dueDate,
      document: previous.document,
      reconciliation,
      extractedPayeeName,
      payeeIdentity,
      changeKind: "revised",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      currency: declared.currency,
      externalInvoiceNumber,
      normalizedInvoiceNumberKey,
      latestVersion: nextNumber,
      // A DRAFT never carries a stale accepted mismatch from an earlier, now-superseded version.
      mismatchOverride: null,
      payeeMismatchOverride: null,
      display: buildInvoiceHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreateInvoiceVersion(tx, version);
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_VERSION_CREATED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { previousVersion: previous.version, newVersion: nextNumber, changeKind: "revised", reconciliationState: reconciliation.state, reason: input.reason },
      requestId,
      createdAt: now,
    });
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_PAYEE_IDENTITY_CHECKED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { version: nextNumber, payeeIdentityStatus: payeeIdentity.overallStatus },
      requestId,
      createdAt: now,
    });
    if (payableRevisionDetected) {
      appendInvoiceEvent(tx, {
        invoiceRef: head.invoiceRef,
        kind: "PAYABLE_REVISION_DETECTED",
        version: nextNumber,
        actorUserRef: actor!.userRef,
        metadata: { payableRef: previous.payablePin.payableRef, payableVersion: previous.payablePin.payableVersion },
        requestId,
        createdAt: now,
      });
    }
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, result.version) };
}

// --- Attach / replace the original Invoice document (section 10) ------------------------------------------------------------------
export async function attachInvoiceDocument(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceInvoicesServiceResult<InvoiceDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = attachInvoiceDocumentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedInvoice(actor, input.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  const { head: currentHead, displayName, liveScope } = loaded.authorized;
  if (currentHead.status !== "DRAFT") return financeInvoicesConflictResult("A document can only be attached to or replaced on a draft invoice.");
  if (currentHead.docVersion !== input.expectedDocVersion) return financeInvoicesStaleResult();

  const previous = await getInvoiceVersionDoc(currentHead.invoiceRef, currentHead.latestVersion);
  if (!previous) return financeInvoicesNotFoundResult();

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(input.contentBase64, "base64");
  } catch {
    return financeInvoicesInvalidInputResult("The document content is not valid base64.");
  }
  const validation = validateInvoicePdf(bytes);
  if (!validation.ok) return financeInvoicesInvalidInputResult(`The document could not be stored: ${validation.reason.replace(/_/g, " ")}.`);

  const resolution = getInvoiceDocumentStorage();
  if (resolution.state === "NOT_CONFIGURED") return financeInvoicesConflictResult("Document storage not configured");

  const artifactSha256 = sha256Hex(bytes);
  const stored = await resolution.storage.store({
    idempotencyKey: invoiceDocumentIdempotencyKey(currentHead.invoiceRef, currentHead.latestVersion + 1, artifactSha256),
    bytes,
    mimeType: INVOICE_DOCUMENT_MIME_TYPE,
    fileName: input.fileName,
    metadata: { invoiceRef: currentHead.invoiceRef, version: currentHead.latestVersion + 1, counterpartyType: currentHead.counterpartyType, counterpartyRef: currentHead.counterpartyRef, artifactSha256 },
  });
  if (!stored.ok) return financeInvoicesConflictResult(`The document could not be stored: ${stored.message}`);

  const documentDto: InvoiceDocumentDto = {
    documentId: stored.data.documentId,
    fileName: input.fileName,
    mimeType: INVOICE_DOCUMENT_MIME_TYPE,
    sizeBytes: bytes.byteLength,
    sha256: artifactSha256,
    storedAt: new Date().toISOString(),
    storedByUserRef: actor!.userRef,
  };

  const declared = {
    currency: previous.currency,
    subtotalMinor: previous.subtotalMinor,
    taxLines: previous.taxLines,
    declaredTotalMinor: previous.declaredTotalMinor,
    externalInvoiceNumber: previous.externalInvoiceNumber,
    counterpartyType: previous.payablePin.counterpartyType,
    counterpartyRef: previous.payablePin.counterpartyRef,
    commercialPeriod: previous.payablePin.commercialPeriod,
  };

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetInvoiceHead(tx, input.invoiceRef);
    const failure = checkDraftRevisable(head, input.expectedDocVersion);
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const latest = await txGetInvoiceVersion(tx, input.invoiceRef, head.latestVersion);
    if (!latest || latest.version !== previous.version) return { kind: "stale" };

    const now = new Date().toISOString();
    const reconciliation = reconcileInvoiceAgainstPayable({ declared, pin: previous.payablePin, documentPresent: true, documentRequired: true, duplicateNumberDetected: false }, () => new Date(now));

    const nextNumber = head.latestVersion + 1;
    const version = invoiceVersionDocSchema.parse({
      ...previous,
      version: nextNumber,
      document: { ...documentDto, storedAt: now },
      reconciliation,
      changeKind: "document_attached",
      reason: null,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: InvoiceHeadDoc = invoiceHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      latestVersion: nextNumber,
      mismatchOverride: null,
      payeeMismatchOverride: null,
      display: buildInvoiceHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreateInvoiceVersion(tx, version);
    txSetInvoiceHead(tx, nextHead);
    appendInvoiceEvent(tx, {
      invoiceRef: head.invoiceRef,
      kind: "INVOICE_DOCUMENT_ATTACHED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { previousVersion: previous.version, newVersion: nextNumber, changeKind: "document_attached", documentId: documentDto.documentId, fileName: documentDto.fileName, mimeType: documentDto.mimeType },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildInvoiceDetailDto(actor!, result.head, displayName, result.version) };
}

// --- Reconcile (read-only, section 11) ------------------------------------------------------------------------------------------
// Recomputes the reconciliation of the CURRENT latest version fresh, against a FRESH duplicate-number
// check (another Invoice head may have claimed the same normalized number since this version was
// written) - it never writes anything, and it never changes the invoice-number claim. Available for
// any lifecycle state (it is purely informational).
export async function reconcileInvoice(actor: ActorContext | null, rawInput: unknown): Promise<FinanceInvoicesServiceResult<InvoiceVersionDto>> {
  const access = await requireAuthoringAccess(actor, "manage_invoices");
  if (!access.ok) return financeInvoicesUnauthorizedResult(access.reason);

  const parsed = reconcileInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeInvoicesInvalidInputResult(formatIssues(parsed.error));

  const loaded = await loadAuthorizedInvoice(actor, parsed.data.invoiceRef, "manage_invoices");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;

  const current = await getInvoiceVersionDoc(head.invoiceRef, head.latestVersion);
  if (!current) return financeInvoicesNotFoundResult();

  let duplicateNumberDetected = false;
  if (current.normalizedInvoiceNumberKey !== null) {
    const claimId = invoiceNumberClaimId(head.counterpartyType, head.counterpartyRef, current.normalizedInvoiceNumberKey);
    const claim = await getInvoiceNumberClaimDoc(claimId);
    duplicateNumberDetected = claim !== null && claim.invoiceRef !== head.invoiceRef;
  }

  const declared = {
    currency: current.currency,
    subtotalMinor: current.subtotalMinor,
    taxLines: current.taxLines,
    declaredTotalMinor: current.declaredTotalMinor,
    externalInvoiceNumber: current.externalInvoiceNumber,
    counterpartyType: current.payablePin.counterpartyType,
    counterpartyRef: current.payablePin.counterpartyRef,
    commercialPeriod: current.payablePin.commercialPeriod,
  };
  const reconciliation = reconcileInvoiceAgainstPayable({ declared, pin: current.payablePin, documentPresent: current.document !== null, documentRequired: true, duplicateNumberDetected });

  const amounts = await requireAmountsSensitiveAccess(actor!);
  return { ok: true, data: toInvoiceVersionDto({ ...current, reconciliation }, { amountsVisible: amounts.ok }, head.payeeMismatchOverride) };
}
