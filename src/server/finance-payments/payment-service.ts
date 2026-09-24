import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toPaymentEventDto, type PaymentDetailDto, type PaymentEventDto } from "./client-dto";
import {
  DEFAULT_PAYMENT_EVENT_PAGE,
  MAX_PAYMENT_EVENT_PAGE,
  getPaymentVersionDoc,
  listPaymentEventDocs,
  txCreatePaymentHead,
  txCreatePaymentVersion,
  txGetPaymentHead,
  txGetPaymentVersion,
  txSetPaymentHead,
} from "./firestore";
import { loadAuthorizedPayment, loadAuthorizedPaymentCounterparty, requireAuthoringAccess } from "./finance-payments-gate";
import { generatePaymentRef, normalizeExternalReference } from "./ids";
import { appendPaymentEvent } from "./payment-events";
import { resolvePaymentInvoiceSource } from "./payment-source";
import { buildPaymentDetailDto, buildPaymentHeadDisplay, formatIssues, isAlreadyExistsError, scopeFieldsOf } from "./service-common";
import {
  createPaymentDraftInputSchema,
  financePaymentsConflictResult,
  financePaymentsInvalidInputResult,
  financePaymentsNotFoundResult,
  financePaymentsNotReadyResult,
  financePaymentsStaleResult,
  financePaymentsUnauthorizedResult,
  paymentHeadDocSchema,
  paymentVersionDocSchema,
  revisePaymentDraftInputSchema,
  type FinancePaymentsErrorResult,
  type FinancePaymentsServiceResult,
  type PaymentHeadDoc,
  type PaymentVersionDoc,
} from "./types";

// Step 17A: the trusted Finance Payments service - create Draft, reads, and DRAFT revision. The
// lifecycle transitions (record/confirm/fail/void/reopen) and the settlement read model live in
// payment-lifecycle-service.ts. Mirrors src/server/finance-invoices/invoice-service.ts's own shape.
//
// Every command runs the gate chain (Authentication -> Admission -> FeatureAccess(finance) ->
// ActionPermission -> live RecordScope -> lifecycle preconditions inside the transaction), writes
// ONLY financePayments*/financePaymentReferenceClaims/financePaymentSettlements documents, appends
// its audit event(s) in the SAME transaction, and NEVER writes an Invoice, a Payable, an Agreement
// or a Partner Review document.
//
// VERSIONS ARE IMMUTABLE. Every change - a revision, a reopen - tx.creates the NEXT version and
// leaves every earlier one byte-identical.

// --- Create (NOT idempotent-by-ref: section 4 requires one-or-more Payments per Invoice) --------------------------------------
export type CreatePaymentOutcome = { payment: PaymentDetailDto };

export async function createPaymentDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<CreatePaymentOutcome>> {
  const access = await requireAuthoringAccess(actor, "manage_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = createPaymentDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));

  const source = await resolvePaymentInvoiceSource(actor!, parsed.data.invoiceRef);
  if (!source.ok) return financePaymentsNotReadyResult("A payment cannot be created from this invoice yet.", source.blockers);
  const { pin, payeeIdentity, counterpartyDisplayName } = source.resolved;

  const loadedCounterparty = await loadAuthorizedPaymentCounterparty(actor!, pin.counterpartyType, pin.counterpartyRef);
  if (!loadedCounterparty.ok) return loadedCounterparty.error;
  const scope = scopeFieldsOf(loadedCounterparty.authorized.scope);

  const paymentRef = generatePaymentRef();

  type CreateTxResult = { kind: "created"; head: PaymentHeadDoc; version: PaymentVersionDoc } | { kind: "conflict" };

  let txResult: CreateTxResult;
  try {
    txResult = await getAdminFirestore().runTransaction<CreateTxResult>(async (tx) => {
      const now = new Date().toISOString();
      const version = paymentVersionDocSchema.parse({
        paymentRef,
        version: 1,
        invoicePin: pin,
        payeeIdentity,
        amountMinor: null,
        paymentDate: null,
        method: null,
        externalReference: null,
        normalizedExternalReferenceKey: null,
        memo: null,
        changeKind: "created",
        reason: null,
        createdAt: now,
        createdByUserRef: actor!.userRef,
      });

      const head: PaymentHeadDoc = paymentHeadDocSchema.parse({
        paymentRef,
        docVersion: 1,
        invoiceRef: pin.invoiceRef,
        payableRef: pin.payableRef,
        counterpartyType: pin.counterpartyType,
        counterpartyRef: pin.counterpartyRef,
        currency: pin.currency,
        ...scope,
        status: "DRAFT",
        latestVersion: 1,
        display: buildPaymentHeadDisplay({ counterpartyName: counterpartyDisplayName, version, status: "DRAFT", projectedAt: now }),
        createdAt: now,
        createdByUserRef: actor!.userRef,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      });

      txCreatePaymentHead(tx, head);
      txCreatePaymentVersion(tx, version);
      appendPaymentEvent(tx, { paymentRef, kind: "PAYMENT_CREATED", version: 1, actorUserRef: actor!.userRef, metadata: { invoiceRef: pin.invoiceRef, invoiceVersion: pin.invoiceVersion, payableRef: pin.payableRef, payableVersion: pin.payableVersion }, requestId, createdAt: now });
      appendPaymentEvent(tx, { paymentRef, kind: "PAYMENT_VERSION_CREATED", version: 1, actorUserRef: actor!.userRef, metadata: { version: 1, changeKind: "created" }, requestId, createdAt: now });
      return { kind: "created", head, version };
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return financePaymentsConflictResult("A payment with this reference already exists. Try again.");
  }

  if (txResult.kind === "conflict") return financePaymentsConflictResult("A payment with this reference already exists. Try again.");
  return { ok: true, data: { payment: await buildPaymentDetailDto(actor!, txResult.head, counterpartyDisplayName, txResult.version) } };
}

// --- Reads -----------------------------------------------------------------------------------------------------------------------
const versionNumberSchema = z.number().int().min(1);

export async function getPayment(actor: ActorContext | null, paymentRef: unknown, input: { version?: unknown } = {}): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const loaded = await loadAuthorizedPayment(actor, typeof paymentRef === "string" ? paymentRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;

  let versionNumber = head.latestVersion;
  if (input.version !== undefined) {
    const parsedVersion = versionNumberSchema.safeParse(input.version);
    if (!parsedVersion.success) return financePaymentsInvalidInputResult("version must be a positive integer.");
    versionNumber = parsedVersion.data;
  }
  const version = await getPaymentVersionDoc(head.paymentRef, versionNumber);
  if (!version) return financePaymentsNotFoundResult();
  return { ok: true, data: await buildPaymentDetailDto(actor!, head, displayName, version) };
}

const eventLimitSchema = z.number().int().min(1).max(MAX_PAYMENT_EVENT_PAGE);

export async function listPaymentEvents(actor: ActorContext | null, paymentRef: unknown, input: { limit?: unknown } = {}): Promise<FinancePaymentsServiceResult<{ paymentRef: string; events: PaymentEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedPayment(actor, typeof paymentRef === "string" ? paymentRef : "");
  if (!loaded.ok) return loaded.error;
  let limit = DEFAULT_PAYMENT_EVENT_PAGE;
  if (input.limit !== undefined) {
    const parsedLimit = eventLimitSchema.safeParse(input.limit);
    if (!parsedLimit.success) return financePaymentsInvalidInputResult(`limit must be an integer between 1 and ${MAX_PAYMENT_EVENT_PAGE}.`);
    limit = parsedLimit.data;
  }
  const page = await listPaymentEventDocs(loaded.authorized.head.paymentRef, limit);
  return { ok: true, data: { paymentRef: loaded.authorized.head.paymentRef, events: page.events.map(toPaymentEventDto), hasMore: page.hasMore } };
}

// --- Revise a DRAFT (mirrors reviseInvoiceDraft's own optional-field-keeps-previous shape) -------------------------------------
function checkDraftRevisable(head: PaymentHeadDoc | null, expectedDocVersion: number): { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string } | null {
  if (!head) return { kind: "not_found" };
  if (head.docVersion !== expectedDocVersion) return { kind: "stale" };
  if (head.status !== "DRAFT") return { kind: "conflict", message: "This payment is not a draft, so it cannot be edited directly." };
  return null;
}

type VersionTxResult = { kind: "ok"; head: PaymentHeadDoc; version: PaymentVersionDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

function failureResult(failure: Exclude<VersionTxResult, { kind: "ok" }>): FinancePaymentsErrorResult {
  if (failure.kind === "not_found") return financePaymentsNotFoundResult();
  if (failure.kind === "stale") return financePaymentsStaleResult();
  return financePaymentsConflictResult(failure.message);
}

export async function revisePaymentDraft(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = revisePaymentDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "manage_payments");
  if (!loaded.ok) return loaded.error;
  const { head: currentHead, displayName } = loaded.authorized;
  if (currentHead.status !== "DRAFT") return financePaymentsConflictResult("This payment is not a draft, so it cannot be edited directly.");

  const previous = await getPaymentVersionDoc(currentHead.paymentRef, currentHead.latestVersion);
  if (!previous) return financePaymentsNotFoundResult();

  // Section 8: "do not silently cap user-entered amount" - the amount is passed through verbatim;
  // only positivity/integer-minor-unit shape is enforced by the schema itself.
  const amountMinor = input.amountMinor === undefined ? previous.amountMinor : input.amountMinor;
  const paymentDate = input.paymentDate === undefined ? previous.paymentDate : input.paymentDate;
  const method = input.method === undefined ? previous.method : input.method;
  const externalReference = input.externalReference === undefined ? previous.externalReference : input.externalReference;
  const normalizedExternalReferenceKey = externalReference === null ? null : normalizeExternalReference(externalReference);
  if (externalReference !== null && normalizedExternalReferenceKey === null) return financePaymentsInvalidInputResult("externalReference must contain at least one non-whitespace character.");
  const memo = input.memo === undefined ? previous.memo : input.memo;

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    const failure = checkDraftRevisable(head, input.expectedDocVersion);
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const latest = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!latest || latest.version !== previous.version) return { kind: "stale" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = paymentVersionDocSchema.parse({
      paymentRef: head.paymentRef,
      version: nextNumber,
      invoicePin: previous.invoicePin,
      payeeIdentity: previous.payeeIdentity,
      amountMinor,
      paymentDate,
      method,
      externalReference,
      normalizedExternalReferenceKey,
      memo,
      changeKind: "revised",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });
    txCreatePaymentVersion(tx, version);

    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      latestVersion: nextNumber,
      overageOverride: null,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: head.status, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);

    appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_VERSION_CREATED", version: nextNumber, actorUserRef: actor!.userRef, metadata: { version: nextNumber, changeKind: "revised", reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, result.version) };
}
