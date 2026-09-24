import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { determinePayableAmount } from "./amount-determination";
import {
  toPayableEventDto,
  toPayableLineDto,
  toPayableSnapshotDto,
  type PayableDetailDto,
  type PayableEventDto,
  type PayableSourcePreviewDto,
} from "./client-dto";
import {
  DEFAULT_PAYABLE_EVENT_PAGE,
  MAX_PAYABLE_EVENT_PAGE,
  getPayableHeadDoc,
  getPayableVersionDoc,
  listPayableEventDocs,
  txCreatePayableHead,
  txCreatePayableVersion,
  txGetPayableHead,
  txGetPayableVersion,
  txPayableHeadExists,
  txSetPayableHead,
} from "./firestore";
import { loadAuthorizedPayable, loadAuthorizedPayableCounterparty, requireAmountsSensitiveAccess, requireFinancePayablesAccess } from "./finance-payables-gate";
import { generatePayableLineRef, payableRefFor } from "./ids";
import { appendPayableEvent } from "./payable-events";
import { buildPayableDetailDto, buildPayableHeadDisplay, formatIssues, isAlreadyExistsError, scopeFieldsOf, versionDerivedFields } from "./service-common";
import { resolvePayableSource, type ResolvedPayableSource } from "./source-evidence";
import {
  addPayableAdjustmentInputSchema,
  confirmPayableTaxInputSchema,
  createPayableInputSchema,
  CURRENT_PAYABLE_CALCULATION_RULE_VERSION,
  financePayablesConflictResult,
  financePayablesInvalidInputResult,
  financePayablesNotFoundResult,
  financePayablesNotReadyResult,
  financePayablesStaleResult,
  financePayablesUnauthorizedResult,
  GST_FINANCE_CONFIRMED_PROVENANCE,
  MAX_PAYABLE_VERSIONS,
  payableHeadDocSchema,
  payableSourceSnapshotSchema,
  payableVersionDocSchema,
  removePayableAdjustmentInputSchema,
  revisePayableInputSchema,
  payableSourceRequestSchema,
  type FinancePayablesErrorResult,
  type FinancePayablesServiceResult,
  type PayableHeadDoc,
  type PayableLine,
  type PayableVersionDoc,
} from "./types";

// Step 15A: the trusted Finance Payables service - preview, idempotent create, reads, DRAFT
// revision and manual adjustments. The two lifecycle transitions (READY_FOR_INVOICE and VOID) live
// in payable-lifecycle-service.ts.
//
// Every command runs the gate chain (Authentication -> Admission -> FeatureAccess(finance) ->
// ActionPermission -> live RecordScope -> lifecycle preconditions inside the transaction), writes
// ONLY financePayables* documents, appends its audit event(s) in the SAME transaction, and never
// writes a Partner Review, an Agreement, a Partner, a Vendor, an Invoice or a Payment record.
//
// VERSIONS ARE IMMUTABLE. Every change - a revision, a manual adjustment added or removed -
// tx.creates the NEXT version and leaves every earlier one byte-identical. Money is never silently
// recalculated: a later Agreement or Review revision is surfaced as a warning
// (source-revision.ts) and adopted only by an explicit, reasoned, audited revision.

// --- Preview (read-only) ------------------------------------------------------------------------------------------------------
// "What would a payable for this commercial basis look like, and why can it or can it not be
// generated?" Resolves the source evidence and runs the determination engine WITHOUT writing
// anything. Needs the same action as creating one (a preview reveals the same commercial figures).
export async function previewPayableSource(actor: ActorContext | null, rawInput: unknown): Promise<FinancePayablesServiceResult<PayableSourcePreviewDto>> {
  const access = await requireFinancePayablesAccess(actor, "manage_payables");
  if (!access.ok) return financePayablesUnauthorizedResult(access.reason);

  const parsed = payableSourceRequestSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));

  const counterparty = await loadAuthorizedPayableCounterparty(actor!, parsed.data.counterpartyType, parsed.data.counterpartyRef);
  if (!counterparty.ok) return counterparty.error;

  const amountsVisible = (await requireAmountsSensitiveAccess(actor!)).ok;
  const options = { amountsVisible };
  const source = await resolvePayableSource(actor!, counterparty.authorized, parsed.data.commercialPeriod, parsed.data.agreementRef);

  const periodBase = { periodKey: parsed.data.commercialPeriod, periodStart: "", periodEnd: "" };
  const common = {
    counterparty: { type: parsed.data.counterpartyType, ref: parsed.data.counterpartyRef, displayName: counterparty.authorized.displayName },
    amountsVisible,
  };

  if (!source.ok) {
    return {
      ok: true,
      data: {
        ...common,
        commercialPeriod: periodBase,
        sourceType: null,
        agreementRef: null,
        agreementVersion: null,
        reviewRef: null,
        reviewVersion: null,
        snapshot: null,
        determinationState: "BLOCKED",
        unresolved: [],
        blockers: source.blockers,
        warnings: [],
        lines: [],
        totalAmountMinorSigned: amountsVisible ? 0 : null,
        currency: null,
        existingPayableRef: await existingPayableRefFor(actor!, parsed.data.counterpartyType, parsed.data.counterpartyRef, parsed.data.commercialPeriod),
        serviceBaseMinor: null,
        gstMinor: amountsVisible ? 0 : null,
        grossInvoiceExpectedMinor: null,
        tdsMinor: amountsVisible ? 0 : null,
        expectedNetPaymentMinor: null,
        calculationRuleVersion: CURRENT_PAYABLE_CALCULATION_RULE_VERSION,
      },
    };
  }

  const resolved = source.resolved;
  const payableRef = payableRefFor({ counterpartyType: resolved.counterpartyType, counterpartyRef: resolved.counterpartyRef, commercialPeriod: resolved.period.periodKey });
  const determination = determinePayableAmount(resolved.snapshot, payableRef);
  const total = determination.lines.reduce((sum, line) => sum + line.amountMinorSigned, 0);

  return {
    ok: true,
    data: {
      ...common,
      commercialPeriod: resolved.period,
      sourceType: resolved.sourceType,
      agreementRef: resolved.agreementRef,
      agreementVersion: resolved.agreementVersion,
      reviewRef: resolved.reviewRef,
      reviewVersion: resolved.reviewVersion,
      snapshot: toPayableSnapshotDto(resolved.snapshot, options),
      determinationState: determination.state,
      unresolved: determination.unresolved,
      blockers: determination.blocked,
      warnings: [...resolved.snapshot.warnings, ...determination.warnings],
      lines: determination.lines.map((line) => toPayableLineDto(line, options)),
      totalAmountMinorSigned: amountsVisible ? total : null,
      currency: resolved.snapshot.currency,
      existingPayableRef: (await getPayableHeadDoc(payableRef)) ? payableRef : null,
      serviceBaseMinor: amountsVisible ? determination.serviceBaseMinor : null,
      gstMinor: amountsVisible ? determination.gstMinor : null,
      grossInvoiceExpectedMinor: amountsVisible ? determination.grossInvoiceExpectedMinor : null,
      tdsMinor: amountsVisible ? determination.tdsMinor : null,
      expectedNetPaymentMinor: amountsVisible ? determination.expectedNetPaymentMinor : null,
      calculationRuleVersion: determination.calculationRuleVersion,
    },
  };
}

// The canonical Payable for a basis, if one exists AND the actor may see it. Used only to tell a
// previewing actor that generating would hit an existing record.
async function existingPayableRefFor(actor: ActorContext, counterpartyType: "PARTNER" | "VENDOR", counterpartyRef: string, commercialPeriod: string): Promise<string | null> {
  const payableRef = payableRefFor({ counterpartyType, counterpartyRef, commercialPeriod });
  const loaded = await loadAuthorizedPayable(actor, payableRef);
  return loaded.ok ? payableRef : null;
}

// --- Create (idempotent) --------------------------------------------------------------------------------------------------------
export type CreatePayableOutcome = { outcome: "created" | "existing"; payable: PayableDetailDto };

// Creates the canonical Payable for one commercial basis: the head plus IMMUTABLE version 1.
//
// IDEMPOTENT BY CONSTRUCTION. The payableRef is DETERMINISTIC in (counterparty type, counterparty
// ref, commercial period), so it IS the document id: a retried or concurrent create for the same
// basis can only ever resolve to the ONE head (the loser's tx.create fails with ALREADY_EXISTS and
// hands back the winner's Payable). The FULL business key - the basis plus the exact pinned
// Agreement and Review versions - is stored on the head, so:
//   - the same key retried returns the existing canonical Payable unchanged;
//   - a DIFFERENT key for the same basis (a newer valid Review or Agreement version) is a CONFLICT
//     naming the explicit revision path, never a second Payable and never a silent recalculation.
export async function createPayable(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<CreatePayableOutcome>> {
  const access = await requireFinancePayablesAccess(actor, "manage_payables");
  if (!access.ok) return financePayablesUnauthorizedResult(access.reason);

  const parsed = createPayableInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));

  const counterparty = await loadAuthorizedPayableCounterparty(actor!, parsed.data.counterpartyType, parsed.data.counterpartyRef);
  if (!counterparty.ok) return counterparty.error;

  const payableRef = payableRefFor({ counterpartyType: parsed.data.counterpartyType, counterpartyRef: parsed.data.counterpartyRef, commercialPeriod: parsed.data.commercialPeriod });
  const source = await resolvePayableSource(actor!, counterparty.authorized, parsed.data.commercialPeriod, parsed.data.agreementRef);

  // A canonical Payable for this basis already exists: creating is never a second record.
  const existingHead = await getPayableHeadDoc(payableRef);
  if (existingHead) return resolveExistingPayable(actor!, payableRef, source.ok ? source.resolved.businessKey : existingHead.businessKey);

  if (!source.ok) return financePayablesNotReadyResult("This payable cannot be generated from the available commercial evidence.", source.blockers);

  const determination = determinePayableAmount(source.resolved.snapshot, payableRef);
  if (determination.state === "BLOCKED") return financePayablesNotReadyResult("This payable cannot be generated from the available commercial evidence.", determination.blocked);

  const resolved = source.resolved;
  type CreateTxResult = { kind: "created"; head: PayableHeadDoc; version: PayableVersionDoc } | { kind: "existing" };

  let txResult: CreateTxResult;
  try {
    txResult = await getAdminFirestore().runTransaction<CreateTxResult>(async (tx) => {
      if (await txPayableHeadExists(tx, payableRef)) return { kind: "existing" };

      const now = new Date().toISOString();
      const version = payableVersionDocSchema.parse({
        payableRef,
        version: 1,
        businessKey: resolved.businessKey,
        snapshot: resolved.snapshot,
        ...versionDerivedFields(determination, determination.lines),
        currency: resolved.snapshot.currency!,
        changeKind: "created",
        reason: null,
        createdAt: now,
        createdByUserRef: actor!.userRef,
      });

      const head: PayableHeadDoc = payableHeadDocSchema.parse({
        payableRef,
        docVersion: 1,
        counterpartyType: resolved.counterpartyType,
        counterpartyRef: resolved.counterpartyRef,
        periodKey: resolved.period.periodKey,
        periodStart: resolved.period.periodStart,
        periodEnd: resolved.period.periodEnd,
        currency: version.currency,
        sourceType: resolved.sourceType,
        agreementRef: resolved.agreementRef,
        agreementVersion: resolved.agreementVersion,
        sourceReviewRef: resolved.reviewRef,
        sourceReviewVersion: resolved.reviewVersion,
        businessKey: resolved.businessKey,
        ...scopeFieldsOf(counterparty.authorized.scope),
        status: "DRAFT",
        latestVersion: 1,
        readyVersion: null,
        display: buildPayableHeadDisplay({ counterpartyName: counterparty.authorized.displayName, version, projectedAt: now }),
        createdAt: now,
        createdByUserRef: actor!.userRef,
        updatedAt: now,
        updatedByUserRef: actor!.userRef,
      });

      txCreatePayableHead(tx, head);
      txCreatePayableVersion(tx, version);
      appendPayableEvent(tx, {
        payableRef,
        kind: "PAYABLE_CREATED",
        version: 1,
        actorUserRef: actor!.userRef,
        metadata: {
          counterpartyType: resolved.counterpartyType,
          counterpartyRef: resolved.counterpartyRef,
          commercialPeriod: resolved.period.periodKey,
          sourceType: resolved.sourceType,
          agreementRef: resolved.agreementRef,
          agreementVersion: resolved.agreementVersion,
          ...(resolved.reviewRef ? { reviewRef: resolved.reviewRef, reviewVersion: resolved.reviewVersion } : {}),
          currency: version.currency,
          determinationState: version.determination.state,
          openReviewCodes: version.openReviewCodes,
          lineCount: version.lines.length,
        },
        requestId,
        createdAt: now,
      });
      appendPayableEvent(tx, {
        payableRef,
        kind: "PAYABLE_VERSION_CREATED",
        version: 1,
        actorUserRef: actor!.userRef,
        metadata: { version: 1, changeKind: "created", determinationState: version.determination.state, lineCount: version.lines.length, openReviewCount: version.openReviewCodes.length },
        requestId,
        createdAt: now,
      });
      return { kind: "created", head, version };
    });
  } catch (error) {
    // A parallel create for the same basis won the head's tx.create: hand back its Payable.
    if (!isAlreadyExistsError(error)) throw error;
    return resolveExistingPayable(actor!, payableRef, resolved.businessKey);
  }

  if (txResult.kind === "existing") return resolveExistingPayable(actor!, payableRef, resolved.businessKey);
  return { ok: true, data: { outcome: "created", payable: await buildPayableDetailDto(actor!, txResult.head, counterparty.authorized.displayName, txResult.version) } };
}

async function resolveExistingPayable(actor: ActorContext, payableRef: string, businessKey: string): Promise<FinancePayablesServiceResult<CreatePayableOutcome>> {
  const loaded = await loadAuthorizedPayable(actor, payableRef);
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;

  if (head.status === "VOID") {
    return financePayablesConflictResult("A payable for this counterparty and commercial period was voided. A voided payable is kept as history and is never regenerated in place.");
  }
  if (head.businessKey !== businessKey) {
    return financePayablesConflictResult(
      "A payable already exists for this counterparty and commercial period, based on different source versions. Revise that payable to adopt the newer source instead of creating a second one.",
    );
  }

  const version = await getPayableVersionDoc(head.payableRef, head.latestVersion);
  return { ok: true, data: { outcome: "existing", payable: await buildPayableDetailDto(actor, head, displayName, version) } };
}

// --- Reads -----------------------------------------------------------------------------------------------------------------------
const versionNumberSchema = z.number().int().min(1);

// Head + bounded version summaries + one version's full detail (default: the latest). Read gate =
// finance feature + LIVE Record Scope; knowing a payableRef never grants access. Every money
// figure needs the finance_amounts category.
export async function getPayable(actor: ActorContext | null, payableRef: unknown, input: { version?: unknown } = {}): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const loaded = await loadAuthorizedPayable(actor, typeof payableRef === "string" ? payableRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, displayName } = loaded.authorized;

  let versionNumber = head.latestVersion;
  if (input.version !== undefined) {
    const parsedVersion = versionNumberSchema.safeParse(input.version);
    if (!parsedVersion.success) return financePayablesInvalidInputResult("version must be a positive integer.");
    versionNumber = parsedVersion.data;
  }
  const version = await getPayableVersionDoc(head.payableRef, versionNumber);
  if (!version) return financePayablesNotFoundResult();
  return { ok: true, data: await buildPayableDetailDto(actor!, head, displayName, version) };
}

const eventLimitSchema = z.number().int().min(1).max(MAX_PAYABLE_EVENT_PAGE);

// Newest first, one bounded page (no cursor). Event metadata is allowlist-redacted on the way out
// and carries no amount at all.
export async function listPayableEvents(actor: ActorContext | null, payableRef: unknown, input: { limit?: unknown } = {}): Promise<FinancePayablesServiceResult<{ payableRef: string; events: PayableEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedPayable(actor, typeof payableRef === "string" ? payableRef : "");
  if (!loaded.ok) return loaded.error;
  let limit = DEFAULT_PAYABLE_EVENT_PAGE;
  if (input.limit !== undefined) {
    const parsedLimit = eventLimitSchema.safeParse(input.limit);
    if (!parsedLimit.success) return financePayablesInvalidInputResult(`limit must be an integer between 1 and ${MAX_PAYABLE_EVENT_PAGE}.`);
    limit = parsedLimit.data;
  }
  const listed = await listPayableEventDocs(loaded.authorized.head.payableRef, limit);
  return { ok: true, data: { payableRef: loaded.authorized.head.payableRef, events: listed.events.map(toPayableEventDto), hasMore: listed.hasMore } };
}

// --- DRAFT revision --------------------------------------------------------------------------------------------------------------
type MutationFailure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

function mutationFailureResult(failure: MutationFailure): FinancePayablesErrorResult {
  if (failure.kind === "not_found") return financePayablesNotFoundResult();
  if (failure.kind === "stale") return financePayablesStaleResult();
  return financePayablesConflictResult(failure.message);
}

type VersionTxResult = { kind: "ok"; head: PayableHeadDoc; version: PayableVersionDoc } | MutationFailure;

// Guard shared by every command that appends a new version: the head must exist, match the
// caller's expectedDocVersion, not be VOID, and have room for another version.
function checkRevisable(head: PayableHeadDoc | null, expectedDocVersion: number, options: { draftOnly: boolean }): MutationFailure | null {
  if (!head) return { kind: "not_found" };
  if (head.docVersion !== expectedDocVersion) return { kind: "stale" };
  if (head.status === "VOID") return { kind: "conflict", message: "This payable is voided and can no longer be changed." };
  if (options.draftOnly && head.status !== "DRAFT") return { kind: "conflict", message: "This payable is ready for invoicing. Revise it back to draft before changing its amount." };
  if (head.latestVersion >= MAX_PAYABLE_VERSIONS) return { kind: "conflict", message: "This payable has reached its maximum number of versions." };
  return null;
}

// Creates the NEXT immutable version of a payable.
//
//   refreshSource: false  keep the pinned evidence exactly as it is and recompute the breakdown
//                         over it (an audited "recheck", never a change of source).
//   refreshSource: true   re-resolve the CURRENT governing Agreement version and finalized Review
//                         version and pin those instead. This is the ONLY way a later Agreement or
//                         Review revision ever reaches a payable, it is explicit, it requires a
//                         reason, and it never rewrites an earlier version.
//
// A payable that was READY_FOR_INVOICE returns to DRAFT: the version an Invoice would have
// consumed stays pinned in history, but it is no longer the payable's ready version.
export async function revisePayable(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const access = await requireFinancePayablesAccess(actor, "manage_payables");
  if (!access.ok) return financePayablesUnauthorizedResult(access.reason);

  const parsed = revisePayableInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayable(actor, input.payableRef, "manage_payables");
  if (!loaded.ok) return loaded.error;
  const { head: currentHead, displayName, liveScope } = loaded.authorized;
  if (currentHead.status === "VOID") return financePayablesConflictResult("This payable is voided and can no longer be changed.");

  const previous = await getPayableVersionDoc(currentHead.payableRef, currentHead.latestVersion);
  if (!previous) return financePayablesNotFoundResult();

  // Source resolution happens OUTSIDE the transaction (it reads two other modules' published
  // contracts); the transaction then re-verifies the head's docVersion before writing.
  let resolved: ResolvedPayableSource | null = null;
  if (input.refreshSource) {
    const counterparty = await loadAuthorizedPayableCounterparty(actor!, currentHead.counterpartyType, currentHead.counterpartyRef);
    if (!counterparty.ok) return counterparty.error;
    const source = await resolvePayableSource(actor!, counterparty.authorized, currentHead.periodKey, currentHead.counterpartyType === "VENDOR" ? currentHead.agreementRef : undefined);
    if (!source.ok) return financePayablesNotReadyResult("The current commercial evidence cannot support this payable, so it was not refreshed.", source.blockers);
    resolved = source.resolved;
  }

  const snapshot = resolved?.snapshot ?? previous.snapshot;
  const businessKey = resolved?.businessKey ?? previous.businessKey;
  const determination = determinePayableAmount(snapshot, currentHead.payableRef);
  if (determination.state === "BLOCKED") return financePayablesNotReadyResult("This payable cannot be determined from the refreshed evidence.", determination.blocked);
  if (snapshot.currency === null) return financePayablesNotReadyResult("This payable cannot be determined from the refreshed evidence.", [{ code: "CURRENCY_MISSING", message: "The governing Agreement version states no currency." }]);

  const manualLines = previous.lines.filter((line) => line.category === "MANUAL_ADJUSTMENT");
  const sourceChanged = resolved !== null && businessKey !== previous.businessKey;

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    const failure = checkRevisable(head, input.expectedDocVersion, { draftOnly: false });
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    // The version the caller was looking at must still be the latest one.
    const latest = await txGetPayableVersion(tx, input.payableRef, head.latestVersion);
    if (!latest || latest.version !== previous.version) return { kind: "stale" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = payableVersionDocSchema.parse({
      payableRef: head.payableRef,
      version: nextNumber,
      businessKey,
      snapshot,
      ...versionDerivedFields(determination, [...determination.lines, ...manualLines]),
      currency: snapshot.currency,
      changeKind: "revised",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      currency: version.currency,
      agreementRef: snapshot.agreement.agreementRef,
      agreementVersion: snapshot.agreement.agreementVersion,
      sourceReviewRef: snapshot.review?.reviewRef ?? null,
      sourceReviewVersion: snapshot.review?.reviewVersion ?? null,
      businessKey,
      status: "DRAFT",
      latestVersion: nextNumber,
      readyVersion: null,
      readyAt: null,
      readyByUserRef: null,
      display: buildPayableHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreatePayableVersion(tx, version);
    txSetPayableHead(tx, nextHead);
    if (sourceChanged) {
      appendPayableEvent(tx, {
        payableRef: head.payableRef,
        kind: "SOURCE_REVISION_DETECTED",
        version: nextNumber,
        actorUserRef: actor!.userRef,
        metadata: {
          previousAgreementVersion: previous.snapshot.agreement.agreementVersion,
          agreementRef: snapshot.agreement.agreementRef,
          agreementVersion: snapshot.agreement.agreementVersion,
          ...(previous.snapshot.review ? { previousReviewVersion: previous.snapshot.review.reviewVersion } : {}),
          ...(snapshot.review ? { reviewRef: snapshot.review.reviewRef, reviewVersion: snapshot.review.reviewVersion } : {}),
          sourceChanged: true,
        },
        requestId,
        createdAt: now,
      });
    }
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_VERSION_CREATED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: {
        previousVersion: previous.version,
        newVersion: nextNumber,
        changeKind: "revised",
        refreshSource: input.refreshSource,
        sourceChanged,
        determinationState: version.determination.state,
        lineCount: version.lines.length,
        openReviewCount: version.openReviewCodes.length,
        reason: input.reason,
      },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, result.version) };
}

// --- Manual adjustments ------------------------------------------------------------------------------------------------------------
// A manual financial adjustment needs the EXACT `adjust_payables` action AND the `finance_amounts`
// sensitive category (you cannot set money you may not see), a non-empty reason, and a DRAFT
// payable. It is audit-logged, and it can never mutate an already immutable prior version: like
// every other change it appends the NEXT version.
//
// `resolvesCode` records that this line is Finance's answer to a named FINANCE_REVIEW_REQUIRED
// item. An adjustment of exactly 0 is a legitimate, fully audited way to record "reviewed, no
// financial effect" - it still needs its reason.
async function requireAdjustAccess(actor: ActorContext | null): Promise<FinancePayablesErrorResult | null> {
  const access = await requireFinancePayablesAccess(actor, "adjust_payables");
  if (!access.ok) return financePayablesUnauthorizedResult(access.reason);
  const amounts = await requireAmountsSensitiveAccess(actor!);
  if (!amounts.ok) return financePayablesUnauthorizedResult(amounts.reason);
  return null;
}

export async function addPayableAdjustment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const denied = await requireAdjustAccess(actor);
  if (denied) return denied;

  const parsed = addPayableAdjustmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayable(actor, input.payableRef, "adjust_payables");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    const failure = checkRevisable(head, input.expectedDocVersion, { draftOnly: true });
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const previous = await txGetPayableVersion(tx, input.payableRef, head.latestVersion);
    if (!previous) return { kind: "not_found" };

    const now = new Date().toISOString();
    const line: PayableLine = {
      lineRef: generatePayableLineRef(),
      label: input.label,
      category: "MANUAL_ADJUSTMENT",
      amountMinorSigned: input.amountMinorSigned,
      source: "MANUAL",
      sourceRef: null,
      reason: input.reason,
      actor: { userRef: actor!.userRef, at: now },
      resolvesCode: input.resolvesCode ?? null,
    };

    const determination = determinePayableAmount(previous.snapshot, head.payableRef);
    if (determination.state === "BLOCKED") return { kind: "conflict", message: "This payable's pinned evidence can no longer be determined." };
    const manualLines = [...previous.lines.filter((existing) => existing.category === "MANUAL_ADJUSTMENT"), line];

    const nextNumber = head.latestVersion + 1;
    const version = payableVersionDocSchema.parse({
      payableRef: head.payableRef,
      version: nextNumber,
      businessKey: previous.businessKey,
      snapshot: previous.snapshot,
      ...versionDerivedFields(determination, [...determination.lines, ...manualLines]),
      currency: previous.currency,
      changeKind: "adjustment_added",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      latestVersion: nextNumber,
      display: buildPayableHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreatePayableVersion(tx, version);
    txSetPayableHead(tx, nextHead);
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "MANUAL_ADJUSTMENT_ADDED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { lineRef: line.lineRef, lineCategory: line.category, label: line.label, reason: input.reason, ...(line.resolvesCode ? { resolvesCode: line.resolvesCode } : {}) },
      requestId,
      createdAt: now,
    });
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_VERSION_CREATED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { previousVersion: previous.version, newVersion: nextNumber, changeKind: "adjustment_added", determinationState: version.determination.state, lineCount: version.lines.length, openReviewCount: version.openReviewCodes.length },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, result.version) };
}

export async function removePayableAdjustment(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const denied = await requireAdjustAccess(actor);
  if (denied) return denied;

  const parsed = removePayableAdjustmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayable(actor, input.payableRef, "adjust_payables");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    const failure = checkRevisable(head, input.expectedDocVersion, { draftOnly: true });
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const previous = await txGetPayableVersion(tx, input.payableRef, head.latestVersion);
    if (!previous) return { kind: "not_found" };

    const target = previous.lines.find((line) => line.lineRef === input.lineRef);
    if (!target || target.category !== "MANUAL_ADJUSTMENT") return { kind: "conflict", message: "That line is not a manual adjustment of this payable's current version." };

    const determination = determinePayableAmount(previous.snapshot, head.payableRef);
    if (determination.state === "BLOCKED") return { kind: "conflict", message: "This payable's pinned evidence can no longer be determined." };
    const manualLines = previous.lines.filter((line) => line.category === "MANUAL_ADJUSTMENT" && line.lineRef !== input.lineRef);

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const version = payableVersionDocSchema.parse({
      payableRef: head.payableRef,
      version: nextNumber,
      businessKey: previous.businessKey,
      snapshot: previous.snapshot,
      ...versionDerivedFields(determination, [...determination.lines, ...manualLines]),
      currency: previous.currency,
      changeKind: "adjustment_removed",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      latestVersion: nextNumber,
      display: buildPayableHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreatePayableVersion(tx, version);
    txSetPayableHead(tx, nextHead);
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "MANUAL_ADJUSTMENT_REMOVED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { lineRef: target.lineRef, lineCategory: target.category, label: target.label, reason: input.reason },
      requestId,
      createdAt: now,
    });
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_VERSION_CREATED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { previousVersion: previous.version, newVersion: nextNumber, changeKind: "adjustment_removed", determinationState: version.determination.state, lineCount: version.lines.length, openReviewCount: version.openReviewCodes.length },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, result.version) };
}

// --- Tax confirmation (Step 15C.1 section 10) ------------------------------------------------------------------------------------
// GST has no canonical per-counterparty/per-Agreement source in this codebase (see
// source-evidence.ts and types.ts's snapshotTaxSchema). Rather than leaving `gstApplicable`
// hard-coded and permanently false (which would silently treat "unknown" as "no GST, ever"), a
// freshly resolved snapshot pins it `null` ("unconfirmed") for a Partner-Review-sourced payable,
// and the engine raises GST_APPLICABILITY_UNCONFIRMED for it. This is the ONE authorized way that
// review item is ever resolved: it overrides the CURRENT version's own snapshot.tax fields (never
// re-resolving Agreement/Review evidence, never touching anything else in the snapshot) and
// creates the next immutable version from it, exactly like every other Payable mutation. Same
// gate as a manual adjustment (`adjust_payables` + `finance_amounts`) - confirming a tax
// applicability is itself a financial decision.
export async function confirmPayableTax(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinancePayablesServiceResult<PayableDetailDto>> {
  const denied = await requireAdjustAccess(actor);
  if (denied) return denied;

  const parsed = confirmPayableTaxInputSchema.safeParse(rawInput);
  if (!parsed.success) return financePayablesInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedPayable(actor, input.payableRef, "adjust_payables");
  if (!loaded.ok) return loaded.error;
  const { displayName, liveScope } = loaded.authorized;

  const result = await getAdminFirestore().runTransaction<VersionTxResult>(async (tx) => {
    const head = await txGetPayableHead(tx, input.payableRef);
    const failure = checkRevisable(head, input.expectedDocVersion, { draftOnly: true });
    if (failure) return failure;
    if (!head) return { kind: "not_found" };
    const previous = await txGetPayableVersion(tx, input.payableRef, head.latestVersion);
    if (!previous) return { kind: "not_found" };

    if (previous.snapshot.sourceType !== "PARTNER_REVIEW") {
      return { kind: "conflict", message: "GST applicability is only Finance-confirmed for a Partner Review-sourced Payable; this basis carries no GST/TDS at all." };
    }

    const now = new Date().toISOString();
    const snapshot = payableSourceSnapshotSchema.parse({
      ...previous.snapshot,
      tax: {
        ...previous.snapshot.tax,
        gstApplicable: input.gstApplicable,
        gstRateBps: input.gstApplicable ? input.gstRateBps : null,
        gstProvenance: GST_FINANCE_CONFIRMED_PROVENANCE,
      },
    });

    const determination = determinePayableAmount(snapshot, head.payableRef);
    if (determination.state === "BLOCKED") return { kind: "conflict", message: "This payable's pinned evidence can no longer be determined." };
    const manualLines = previous.lines.filter((line) => line.category === "MANUAL_ADJUSTMENT");

    const nextNumber = head.latestVersion + 1;
    const version = payableVersionDocSchema.parse({
      payableRef: head.payableRef,
      version: nextNumber,
      businessKey: previous.businessKey,
      snapshot,
      ...versionDerivedFields(determination, [...determination.lines, ...manualLines]),
      currency: previous.currency,
      changeKind: "tax_confirmed",
      reason: input.gstApplicable ? `GST confirmed applicable by Finance at ${(input.gstRateBps! / 100).toFixed(2).replace(/\.?0+$/, "")}%.` : "GST confirmed not applicable by Finance.",
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });

    const nextHead: PayableHeadDoc = payableHeadDocSchema.parse({
      ...head,
      ...scopeFieldsOf(liveScope),
      latestVersion: nextNumber,
      display: buildPayableHeadDisplay({ counterpartyName: displayName, version, projectedAt: now }),
      docVersion: head.docVersion + 1,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    });

    txCreatePayableVersion(tx, version);
    txSetPayableHead(tx, nextHead);
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "TAX_CONFIRMED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: { gstApplicable: input.gstApplicable, gstRateBps: input.gstRateBps },
      requestId,
      createdAt: now,
    });
    appendPayableEvent(tx, {
      payableRef: head.payableRef,
      kind: "PAYABLE_VERSION_CREATED",
      version: nextNumber,
      actorUserRef: actor!.userRef,
      metadata: {
        previousVersion: previous.version,
        newVersion: nextNumber,
        changeKind: "tax_confirmed",
        determinationState: version.determination.state,
        lineCount: version.lines.length,
        openReviewCount: version.openReviewCodes.length,
      },
      requestId,
      createdAt: now,
    });
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind !== "ok") return mutationFailureResult(result);
  return { ok: true, data: await buildPayableDetailDto(actor!, result.head, displayName, result.version) };
}
