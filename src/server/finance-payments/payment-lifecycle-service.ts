import { canPerformAction } from "@/server/authz/capabilities";
import { canTransitionLifecycle, PAYMENT_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "./client-dto";
import { toPaymentRowDto } from "./client-dto";
import {
  getPaymentVersionDoc,
  listPaymentHeadDocsForInvoice,
  listPaymentVersionDocs,
  txCreatePaymentReferenceClaim,
  txCreatePaymentVersion,
  txGetPaymentHead,
  txGetPaymentReferenceClaim,
  txGetPaymentSettlementAccumulator,
  txGetPaymentVersion,
  txSetPaymentHead,
  txSetPaymentSettlementAccumulator,
} from "./firestore";
import { loadAuthorizedPayment, requireAmountsSensitiveAccess, requireAuthoringAccess, requireFinancePaymentsAccess } from "./finance-payments-gate";
import { paymentReferenceClaimId } from "./ids";
import { appendPaymentEvent } from "./payment-events";
import { resolvePaymentInvoiceSource } from "./payment-source";
import { computeSettlement } from "./settlement-calculator";
import { buildPaymentDetailDto, buildPaymentHeadDisplay, formatIssues } from "./service-common";
import {
  confirmPaymentInputSchema,
  failPaymentInputSchema,
  financePaymentsConflictResult,
  financePaymentsInvalidInputResult,
  financePaymentsNotFoundResult,
  financePaymentsNotReadyResult,
  financePaymentsStaleResult,
  financePaymentsUnauthorizedResult,
  invoiceSettlementSummaryInputSchema,
  paymentHeadDocSchema,
  paymentVersionDocSchema,
  recordPaymentInputSchema,
  reopenPaymentInputSchema,
  voidPaymentInputSchema,
  type FinancePaymentsErrorResult,
  type FinancePaymentsReadinessIssue,
  type FinancePaymentsServiceResult,
  type PaymentHeadDoc,
  type PaymentSettlementAccumulatorDoc,
} from "./types";

// Step 17A: the Payment LIFECYCLE - record, confirm, mark failed, void, reopen a failed draft -
// plus the read-only Invoice settlement projection. Mirrors
// src/server/finance-invoices/invoice-lifecycle-service.ts's own shape.
//
// DRAFT -> RECORDED -> CONFIRMED | FAILED. FAILED -> DRAFT reopens (a new version under the SAME
// head). VOID is reasoned and reachable from every non-terminal state, INCLUDING CONFIRMED - a
// confirmed payment is never silently edited (its amount/reference stay exactly what they were),
// but it CAN be voided as an explicit, reasoned correction/reversal, which atomically decrements the
// settlement accumulator in the SAME transaction (section 7/20). The transition table itself lives
// centrally in src/server/authz/lifecycle.ts (PAYMENT_LIFECYCLE_TRANSITIONS), the same convention
// every other Finance module's own lifecycle table already follows.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string } | { kind: "not_ready"; message: string; blockers: FinancePaymentsReadinessIssue[] } | { kind: "unauthorized"; reason: "action_denied" };

function failureResult(failure: Failure): FinancePaymentsErrorResult {
  if (failure.kind === "not_found") return financePaymentsNotFoundResult();
  if (failure.kind === "stale") return financePaymentsStaleResult();
  if (failure.kind === "not_ready") return financePaymentsNotReadyResult(failure.message, failure.blockers);
  if (failure.kind === "unauthorized") return financePaymentsUnauthorizedResult(failure.reason);
  return financePaymentsConflictResult(failure.message);
}

type OkResult = { kind: "ok"; head: PaymentHeadDoc };

// --- RECORD ------------------------------------------------------------------------------------------------------------------
// DRAFT -> RECORDED. Preconditions: amount, payment date and method are all declared. If an
// external reference is declared, it is claimed HERE, transactionally (section 10) - a duplicate
// (method, normalized reference) pair used by a DIFFERENT payment head is a conflict; the SAME
// head re-recording (impossible in this lifecycle, since RECORDED cannot re-record, but a future
// reopen->re-record is) is treated as already-claimed and passes through.
export const PAYMENT_NOT_READY_CODES = { missingAmount: "payment_missing_amount", missingDate: "payment_missing_date", missingMethod: "payment_missing_method" } as const;

export async function recordPayment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = recordPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "manage_payments");
  if (!loaded.ok) return loaded.error;
  const { displayName } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!version) return { kind: "not_found" };

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "RECORDED", PAYMENT_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a draft payment can be recorded." };

    const blockers: FinancePaymentsReadinessIssue[] = [];
    if (version.amountMinor === null) blockers.push({ code: PAYMENT_NOT_READY_CODES.missingAmount, message: "The payment amount is not set." });
    if (version.paymentDate === null) blockers.push({ code: PAYMENT_NOT_READY_CODES.missingDate, message: "The payment date is not set." });
    if (version.method === null) blockers.push({ code: PAYMENT_NOT_READY_CODES.missingMethod, message: "The payment method is not set." });
    if (blockers.length > 0) return { kind: "not_ready", message: "This payment is not ready to be recorded.", blockers };

    if (version.externalReference !== null && version.normalizedExternalReferenceKey !== null && version.method !== null) {
      const claimId = paymentReferenceClaimId(version.method, version.normalizedExternalReferenceKey);
      const existingClaim = await txGetPaymentReferenceClaim(tx, claimId);
      if (existingClaim && existingClaim.paymentRef !== head.paymentRef) {
        return { kind: "conflict", message: "This external reference is already used by another payment with the same method." };
      }
      if (!existingClaim) {
        const now = new Date().toISOString();
        txCreatePaymentReferenceClaim(tx, claimId, { claimId, paymentRef: head.paymentRef, method: version.method, normalizedReferenceKey: version.normalizedExternalReferenceKey, createdAt: now });
      }
    }

    const now = new Date().toISOString();
    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      status: "RECORDED",
      recordedVersion: version.version,
      recordedAt: now,
      recordedByUserRef: actor!.userRef,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: "RECORDED", projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);
    appendPaymentEvent(tx, {
      paymentRef: head.paymentRef,
      kind: "PAYMENT_RECORDED",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "RECORDED", method: version.method, hasExternalReference: version.externalReference !== null },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, await getPaymentVersionDoc(result.head.paymentRef, result.head.latestVersion)) };
}

// --- CONFIRM (section 8/19 - THE concurrency-critical transition) --------------------------------------------------------------
// RECORDED -> CONFIRMED. Reads the settlement accumulator INSIDE this same transaction, computes
// what the new confirmed total for the Invoice would be, and blocks if it would exceed the pinned
// expected net payment - UNLESS the actor supplies `overrideOverageReason` AND holds the exact
// `override_payment_overage` action (Head/Super-Admin-only per the seeded grants). Two racing
// confirmations against the SAME invoice serialize on the accumulator document: Firestore retries
// the loser's transaction with a fresh read, so the second one always sees the first one's already-
// updated total before deciding.
export async function confirmPayment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "confirm_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = confirmPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "confirm_payments");
  if (!loaded.ok) return loaded.error;
  const { displayName } = loaded.authorized;

  // Checked ONCE, outside the transaction (a permission grant is never transaction-scoped state) -
  // whether the actor holds the override action at all. Whether it is actually NEEDED is decided
  // inside the transaction, against the fresh accumulator read.
  const mayOverrideOverage = input.overrideOverageReason !== undefined ? await canPerformAction(actor!, "finance", "override_payment_overage") : false;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!version || version.amountMinor === null) return { kind: "not_found" };

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "CONFIRMED", PAYMENT_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a recorded payment can be confirmed." };

    const expectedNetPaymentMinor = version.invoicePin.expectedNetPaymentMinor;
    const accumulator = await txGetPaymentSettlementAccumulator(tx, head.invoiceRef);
    const currentConfirmedTotal = accumulator?.confirmedTotalMinor ?? 0;
    const newConfirmedTotal = currentConfirmedTotal + version.amountMinor;

    const now = new Date().toISOString();
    let overageOverride: PaymentHeadDoc["overageOverride"] = null;
    if (newConfirmedTotal > expectedNetPaymentMinor) {
      if (input.overrideOverageReason === undefined) {
        return {
          kind: "not_ready",
          message: "Confirming this payment would exceed the invoice's expected net payment.",
          blockers: [{ code: "would_overpay", message: `Confirming would bring the confirmed total to ${newConfirmedTotal}, exceeding the expected net payment of ${expectedNetPaymentMinor}.` }],
        };
      }
      if (!mayOverrideOverage) return { kind: "unauthorized", reason: "action_denied" };
      overageOverride = { forVersion: version.version, reason: input.overrideOverageReason, actorUserRef: actor!.userRef, at: now };
    }

    const nextAccumulator: PaymentSettlementAccumulatorDoc = { invoiceRef: head.invoiceRef, expectedNetPaymentMinor, confirmedTotalMinor: newConfirmedTotal, docVersion: (accumulator?.docVersion ?? 0) + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetPaymentSettlementAccumulator(tx, nextAccumulator);

    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      status: "CONFIRMED",
      confirmedVersion: version.version,
      confirmedAt: now,
      confirmedByUserRef: actor!.userRef,
      overageOverride,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: "CONFIRMED", projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);
    appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_CONFIRMED", version: version.version, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "CONFIRMED" }, requestId, createdAt: now });
    if (overageOverride) {
      appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_OVERPAYMENT_OVERRIDE", version: version.version, actorUserRef: actor!.userRef, metadata: { version: version.version, reason: overageOverride.reason }, requestId, createdAt: now });
    }
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, await getPaymentVersionDoc(result.head.paymentRef, result.head.latestVersion)) };
}

// --- FAIL ---------------------------------------------------------------------------------------------------------------------
export async function failPayment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = failPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "manage_payments");
  if (!loaded.ok) return loaded.error;
  const { displayName } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!version) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "FAILED", PAYMENT_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a recorded payment can be marked failed." };

    const now = new Date().toISOString();
    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      status: "FAILED",
      failedVersion: head.latestVersion,
      failedAt: now,
      failedByUserRef: actor!.userRef,
      failedReason: input.reason,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: "FAILED", projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);
    appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_FAILED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "FAILED", reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, await getPaymentVersionDoc(result.head.paymentRef, result.head.latestVersion)) };
}

// --- REOPEN (FAILED -> DRAFT, a new version, mirrors reopenInvoice) -------------------------------------------------------------
export async function reopenPayment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "manage_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = reopenPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "manage_payments");
  if (!loaded.ok) return loaded.error;
  const { displayName } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "DRAFT", PAYMENT_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a failed payment can be reopened." };
    const failed = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!failed) return { kind: "not_found" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = paymentVersionDocSchema.parse({ ...failed, version: nextNumber, changeKind: "reopened", reason: input.reason, createdAt: now, createdByUserRef: actor!.userRef });
    txCreatePaymentVersion(tx, version);

    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      status: "DRAFT",
      latestVersion: nextNumber,
      failedVersion: null,
      failedAt: null,
      failedByUserRef: null,
      failedReason: null,
      overageOverride: null,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: "DRAFT", projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);
    appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_REOPENED", version: nextNumber, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "DRAFT", previousVersion: failed.version, newVersion: nextNumber, changeKind: "reopened", reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, await getPaymentVersionDoc(result.head.paymentRef, result.head.latestVersion)) };
}

// --- VOID (section 7/20 - a CONFIRMED payment can be voided too, as an explicit reversal) --------------------------------------
export async function voidPayment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePaymentsServiceResult<PaymentDetailDto>> {
  const access = await requireAuthoringAccess(actor, "void_payments");
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = voidPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayment(actor, input.paymentRef, "void_payments");
  if (!loaded.ok) return loaded.error;
  const { displayName } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPaymentHead(tx, input.paymentRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetPaymentVersion(tx, input.paymentRef, head.latestVersion);
    if (!version) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "VOID", PAYMENT_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "This payment is already voided." };

    const wasConfirmed = head.status === "CONFIRMED";
    const now = new Date().toISOString();

    // Correction/reversal (section 7/20): a CONFIRMED payment being voided must atomically release
    // its amount from the settlement accumulator, in THIS SAME transaction - never a separate,
    // unsynchronized adjustment.
    if (wasConfirmed && version.amountMinor !== null) {
      const accumulator = await txGetPaymentSettlementAccumulator(tx, head.invoiceRef);
      const currentConfirmedTotal = accumulator?.confirmedTotalMinor ?? 0;
      const nextAccumulator: PaymentSettlementAccumulatorDoc = {
        invoiceRef: head.invoiceRef,
        expectedNetPaymentMinor: accumulator?.expectedNetPaymentMinor ?? version.invoicePin.expectedNetPaymentMinor,
        confirmedTotalMinor: Math.max(0, currentConfirmedTotal - version.amountMinor),
        docVersion: (accumulator?.docVersion ?? 0) + 1,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      };
      txSetPaymentSettlementAccumulator(tx, nextAccumulator);
    }

    const nextHead: PaymentHeadDoc = paymentHeadDocSchema.parse({
      ...head,
      status: "VOID",
      voidedAt: now,
      voidedByUserRef: actor!.userRef,
      voidReason: input.reason,
      confirmedReversedAt: wasConfirmed ? now : head.confirmedReversedAt,
      confirmedReversedByUserRef: wasConfirmed ? actor!.userRef : head.confirmedReversedByUserRef,
      overageOverride: null,
      display: buildPaymentHeadDisplay({ counterpartyName: displayName, version, status: "VOID", projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPaymentHead(tx, nextHead);
    appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_VOIDED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "VOID", reason: input.reason }, requestId, createdAt: now });
    if (wasConfirmed) {
      appendPaymentEvent(tx, { paymentRef: head.paymentRef, kind: "PAYMENT_CONFIRMED_REVERSED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { version: head.latestVersion, reason: input.reason }, requestId, createdAt: now });
    }
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPaymentDetailDto(actor!, result.head, displayName, await getPaymentVersionDoc(result.head.paymentRef, result.head.latestVersion)) };
}

// --- Invoice settlement summary (read-only, section 13/17) -----------------------------------------------------------------------
// Never mutates the Invoice or any Payment. Sourced from a bounded, non-transactional query (this
// is a READ MODEL, not the concurrency-authoritative path - see confirmPayment's own accumulator
// read for that) plus the pure settlement calculator, so what this endpoint reports and what the
// unit tests exercise can never drift apart.
export async function getInvoicePaymentSettlement(actor: ActorContext | null, rawInvoiceRef: unknown): Promise<FinancePaymentsServiceResult<InvoicePaymentSettlementDto>> {
  const access = await requireFinancePaymentsAccess(actor);
  if (!access.ok) return financePaymentsUnauthorizedResult(access.reason);

  const parsed = invoiceSettlementSummaryInputSchema.safeParse({ invoiceRef: rawInvoiceRef });
  if (!parsed.success) return financePaymentsInvalidInputResult(formatIssues(parsed.error));
  const { invoiceRef } = parsed.data;

  // Authorizes the underlying Invoice through Invoices' own published, read-only contract - the
  // actor must already be allowed to see that Invoice (every Payment for it shares its exact
  // counterparty scope, so this one check covers every Payment head below).
  const source = await resolvePaymentInvoiceSource(actor!, invoiceRef);
  const amounts = await requireAmountsSensitiveAccess(actor!);
  const expectedNetPaymentMinor = source.ok ? source.resolved.pin.expectedNetPaymentMinor : null;
  const currency = source.ok ? source.resolved.pin.currency : null;

  const heads = await listPaymentHeadDocsForInvoice(invoiceRef);
  // The method is on the latest VERSION, not the head - the same one small bounded read per row
  // (never the whole collection) that payment-workspace-service.ts's own list already does, so the
  // Settlement tab's related-Payments table (section 12) shows the real method instead of always "—".
  const methods = await Promise.all(heads.map((head) => listPaymentVersionDocs(head.paymentRef, 1)));
  const countable = heads.filter((head) => head.status === "RECORDED" || head.status === "CONFIRMED" || head.status === "FAILED");
  const summary = computeSettlement(
    expectedNetPaymentMinor,
    countable.map((head) => ({ status: head.status, amountMinor: head.display.amountMinor ?? 0 })),
  );
  if (!source.ok) summary.warnings.push("The source invoice could not be resolved for this actor, or is not approved; settlement figures may be incomplete.");

  const options = { amountsVisible: amounts.ok };
  return {
    ok: true,
    data: {
      invoiceRef,
      currency,
      amountsVisible: amounts.ok,
      summary: {
        expectedNetPaymentMinor: expectedNetPaymentMinor !== null ? (amounts.ok ? expectedNetPaymentMinor : null) : null,
        confirmedPaidMinor: amounts.ok ? summary.confirmedPaidMinor : null,
        recordedPendingMinor: amounts.ok ? summary.recordedPendingMinor : null,
        failedMinor: amounts.ok ? summary.failedMinor : null,
        remainingMinor: amounts.ok ? summary.remainingMinor : null,
        overpaidByMinor: amounts.ok ? summary.overpaidByMinor : null,
        state: summary.state,
        warnings: summary.warnings,
      },
      payments: heads.map((head, index) => toPaymentRowDto(head, null, methods[index]?.versions[0]?.method ?? null, options)),
    },
  };
}

// Re-exported so a route/test can list a payment's own version summaries without depending on
// firestore.ts directly (mirrors listInvoiceVersionDocs's own re-export shape).
export { listPaymentVersionDocs };
