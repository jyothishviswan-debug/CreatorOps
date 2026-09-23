import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { canTransitionLifecycle, PAYABLE_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";

import type { PayableDetailDto, PayableSourceRevisionDto } from "./client-dto";
import { getPayableVersionDoc, txGetPayableHead, txGetPayableVersion, txSetPayableHead } from "./firestore";
import { loadAuthorizedPayable, loadAuthorizedPayableCounterparty } from "./finance-payables-gate";
// (loadAuthorizedPayable is used by the read-only source-revision warning below.)
import { appendPayableEvent } from "./payable-events";
import { authorizePayableCommand, buildPayableDetailDto, scopeFieldsOf } from "./service-common";
import { resolvePayableSource } from "./source-evidence";
import { compareSourceVersions, SOURCE_REVISION_MESSAGES, type CurrentSourceVersions } from "./source-revision";
import {
  financePayablesConflictResult,
  financePayablesNotFoundResult,
  financePayablesNotReadyResult,
  financePayablesStaleResult,
  markPayableReadyInputSchema,
  payableHeadDocSchema,
  voidPayableInputSchema,
  type FinancePayablesErrorResult,
  type FinancePayablesReadinessIssue,
  type FinancePayablesServiceResult,
  type PayableHeadDoc,
} from "./types";

// Step 15A: the Payable LIFECYCLE - move to READY_FOR_INVOICE, and void - plus the read-only
// source-revision warning.
//
// The lifecycle is deliberately tiny and finance-specific: DRAFT, READY_FOR_INVOICE, VOID. There
// is NO invoice approval status and NO payment status here, and READY_FOR_INVOICE is never called
// "approved" - no approval workflow exists in Payables. There is no delete: a payable is voided,
// and its versions and events are retained.
//
// READY_FOR_INVOICE needs the exact `approve_payables` action; VOID needs the exact
// `void_payables` action. Both are ONE Firestore transaction that reads the head (and the version
// it needs) first, verifies the caller's optimistic expectedDocVersion against the HEAD, writes
// afterwards, and appends its audit event in the same transaction.
//
// Neither transition creates a payable version: versions are the FINANCIAL history (evidence,
// breakdown, total) and a lifecycle transition changes no money. READY_FOR_INVOICE instead PINS
// the exact immutable version a future Invoice module will consume.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string } | { kind: "not_ready"; message: string; blockers: FinancePayablesReadinessIssue[] };

function failureResult(failure: Failure): FinancePayablesErrorResult {
  if (failure.kind === "not_found") return financePayablesNotFoundResult();
  if (failure.kind === "stale") return financePayablesStaleResult();
  if (failure.kind === "not_ready") return financePayablesNotReadyResult(failure.message, failure.blockers);
  return financePayablesConflictResult(failure.message);
}

type OkResult = { kind: "ok"; head: PayableHeadDoc };

// --- READY_FOR_INVOICE ----------------------------------------------------------------------------------------------------
// Preconditions, every one of them explicit:
//   - the payable is DRAFT (the lifecycle graph allows DRAFT -> READY_FOR_INVOICE only);
//   - its source evidence is resolved - nothing is still waiting on a Finance decision;
//   - its determination is not BLOCKED (a blocked determination is never persisted anyway);
//   - its amount breakdown is complete: at least one line, and a total that is not negative;
//   - the immutable version pinned as `readyVersion` is exactly the payable's latest version.
export const PAYABLE_NOT_READY_CODES = {
  openReviewItems: "payable_open_review_items",
  emptyBreakdown: "payable_empty_breakdown",
  negativeTotal: "payable_negative_total",
} as const;

export async function markPayableReadyForInvoice(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const command = await authorizePayableCommand(actor, "approve_payables", markPayableReadyInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const { displayName, liveScope } = authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    if (!head) return { kind: "not_found" };
    const version = await txGetPayableVersion(tx, input.payableRef, head.latestVersion);

    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "READY_FOR_INVOICE", PAYABLE_LIFECYCLE_TRANSITIONS)) {
      return { kind: "conflict", message: `A ${head.status === "VOID" ? "voided" : "ready"} payable cannot be moved to ready for invoicing.` };
    }
    if (!version) return { kind: "not_found" };

    const blockers: FinancePayablesReadinessIssue[] = [];
    if (version.openReviewCodes.length > 0) {
      blockers.push({ code: PAYABLE_NOT_READY_CODES.openReviewItems, message: `This payable still has ${version.openReviewCodes.length} item(s) awaiting a Finance decision: ${version.openReviewCodes.join(", ")}.` });
    }
    if (version.lines.length === 0) blockers.push({ code: PAYABLE_NOT_READY_CODES.emptyBreakdown, message: "This payable has no amount breakdown lines." });
    if (version.totalAmountMinorSigned < 0) blockers.push({ code: PAYABLE_NOT_READY_CODES.negativeTotal, message: "This payable's total is negative. Correct the adjustments before marking it ready." });
    if (blockers.length > 0) return { kind: "not_ready", message: "This payable is not ready for invoicing.", blockers };

    const now = new Date().toISOString();
    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "READY_FOR_INVOICE",
      readyVersion: version.version,
      readyAt: now,
      readyByUserRef: actor!.userRef,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPayableHead(tx, nextHead);
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_READY_FOR_INVOICE",
      version: version.version,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "READY_FOR_INVOICE", readyVersion: version.version, determinationState: version.determination.state, lineCount: version.lines.length, currency: version.currency },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, await getPayableVersionDoc(result.head.payableRef, result.head.latestVersion)) };
}

// --- VOID ---------------------------------------------------------------------------------------------------------------------
// Terminal and reasoned: nothing leaves VOID, a voided payable can never be invoiced, and every
// historical version and event is retained. There is no delete anywhere in this module.
export async function voidPayable(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const command = await authorizePayableCommand(actor, "void_payables", voidPayableInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const { displayName, liveScope } = authorized;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "VOID", PAYABLE_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "This payable is already voided." };

    const now = new Date().toISOString();
    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      status: "VOID",
      readyVersion: null,
      readyAt: null,
      readyByUserRef: null,
      voidedAt: now,
      voidedByUserRef: actor!.userRef,
      voidReason: input.reason,
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });
    txSetPayableHead(tx, nextHead);
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_VOIDED",
      version: head.latestVersion,
      actorUserRef: actor!.userRef,
      metadata: { fromStatus: head.status, toStatus: "VOID", version: head.latestVersion, reason: input.reason },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, await getPayableVersionDoc(result.head.payableRef, result.head.latestVersion)) };
}

// --- Source-revision warning (read-only, section 16) -------------------------------------------------------------------------
// Compares the payable's PINNED source versions against what governs the same commercial basis
// today. It never writes, never recalculates and never re-pins - acting on it is an explicit
// revision (revisePayable with refreshSource). Needs the read gate only.
export async function getPayableSourceRevision(actor: ActorContext | null, payableRef: unknown): Promise<FinancePayablesServiceResult<PayableSourceRevisionDto>> {
  const loaded = await loadAuthorizedPayable(actor, typeof payableRef === "string" ? payableRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;

  const counterparty = await loadAuthorizedPayableCounterparty(actor!, head.counterpartyType, head.counterpartyRef);
  if (!counterparty.ok) return counterparty.error;

  const source = await resolvePayableSource(actor!, counterparty.authorized, head.periodKey, head.counterpartyType === "VENDOR" ? head.agreementRef : undefined);
  const current: CurrentSourceVersions | null = source.ok
    ? { agreementRef: source.resolved.agreementRef, agreementVersion: source.resolved.agreementVersion, reviewRef: source.resolved.reviewRef, reviewVersion: source.resolved.reviewVersion }
    : null;

  const comparison = compareSourceVersions(head, current);
  const message = current === null ? "The current commercial evidence for this period cannot be resolved right now, so no newer source version is being offered. This payable is unchanged." : SOURCE_REVISION_MESSAGES[comparison.state];

  return {
    ok: true,
    data: {
      payableRef: head.payableRef,
      state: comparison.state,
      message,
      pinned: { agreementRef: head.agreementRef, agreementVersion: head.agreementVersion, reviewRef: head.sourceReviewRef, reviewVersion: head.sourceReviewVersion },
      current,
    },
  };
}
