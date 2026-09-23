import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";

import { openReviewCodesOf, totalOfLines, type PayableDeterminationResult } from "./amount-determination";
import { toPayableHeadDto, toPayableVersionDto, toPayableVersionSummaryDto, type PayableDetailDto } from "./client-dto";
import { listPayableVersionDocs } from "./firestore";
import { loadAuthorizedPayable, requireAmountsSensitiveAccess, requireFinancePayablesAccess, type AuthorizedPayable, type FinancePayableAction } from "./finance-payables-gate";
import {
  financePayablesInvalidInputResult,
  financePayablesUnauthorizedResult,
  payableDeterminationSchema,
  payableHeadDisplaySchema,
  type FinancePayablesErrorResult,
  type PayableHeadDisplay,
  type PayableHeadDoc,
  type PayableLine,
  type PayableVersionDoc,
} from "./types";

// Step 15A: small helpers shared by the Payable read / mutation services and the lifecycle
// service. Nothing here writes; every write lives in the services' own transactions.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

// The head's own scope fields are a point-in-time copy of the LIVE Partner's / Vendor's scope,
// refreshed on every mutation. They only serve bounded scoped list queries.
export function scopeFieldsOf(scope: AuthorizedPayable["liveScope"]): Pick<PayableHeadDoc, "ownerUid" | "regionIds" | "teamIds" | "partnerUid" | "vendorUid"> {
  return { ownerUid: scope.ownerUid, regionIds: scope.regionIds, teamIds: scope.teamIds, partnerUid: scope.partnerUid, vendorUid: scope.vendorUid };
}

export type AuthorizedCommand<T> = { ok: true; input: T; authorized: AuthorizedPayable } | { ok: false; error: FinancePayablesErrorResult };

// The chain every Payable command starts with, in order: Authentication -> Admission ->
// FeatureAccess(finance) -> ActionPermission -> input shape -> live RecordScope (the head's
// Partner / Vendor). Unauthenticated / unauthorized callers learn nothing about the input's
// validity or the record's existence; a missing / out-of-scope / forged payableRef is the same
// neutral not_found.
export async function authorizePayableCommand<T extends { payableRef: string }>(
  actor: ActorContext | null,
  action: FinancePayableAction,
  schema: z.ZodType<T, unknown>,
  rawInput: unknown,
): Promise<AuthorizedCommand<T>> {
  const access = await requireFinancePayablesAccess(actor, action);
  if (!access.ok) return { ok: false, error: financePayablesUnauthorizedResult(access.reason) };

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: financePayablesInvalidInputResult(formatIssues(parsed.error)) };

  const loaded = await loadAuthorizedPayable(actor, parsed.data.payableRef, action);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, input: parsed.data, authorized: loaded.authorized };
}

// Head + bounded version summaries + one version's full detail. Every response - reads AND
// mutation results - is built through here. Exact money figures need the `finance_amounts`
// sensitive category (checked here, not in the DTO): without it every figure is null and the
// response says so with amountsVisible:false.
export async function buildPayableDetailDto(actor: ActorContext, head: PayableHeadDoc, displayName: string | null, selected: PayableVersionDoc | null): Promise<PayableDetailDto> {
  const [versions, amounts] = await Promise.all([listPayableVersionDocs(head.payableRef), requireAmountsSensitiveAccess(actor)]);
  const options = { amountsVisible: amounts.ok };
  return {
    head: toPayableHeadDto(head, displayName, options),
    versions: versions.versions.map((doc) => toPayableVersionSummaryDto(doc, options)),
    hasMoreVersions: versions.hasMore,
    selectedVersion: selected ? toPayableVersionDto(selected, options) : null,
    amountsVisible: amounts.ok,
  };
}

// The head's list projection, recomputed from the version that is now the latest. Never
// authorization and never financial truth - the version documents are.
export function buildPayableHeadDisplay(input: { counterpartyName: string; version: PayableVersionDoc; projectedAt: string }): PayableHeadDisplay {
  return payableHeadDisplaySchema.parse({
    counterpartyName: input.counterpartyName,
    counterpartyNameLower: input.counterpartyName.toLocaleLowerCase(),
    totalAmountMinorSigned: input.version.totalAmountMinorSigned,
    determinationState: input.version.determination.state,
    openReviewCount: input.version.openReviewCodes.length,
    lineCount: input.version.lines.length,
    projectedAt: input.projectedAt,
  });
}

// Assembles the derived parts of a version document from a determination plus the full breakdown
// (engine lines and any manual adjustments), so every writer computes them the one same way.
// `determination` is the engine's full result (amount-determination.ts) - `lines` may add manual
// adjustments on top of `determination.lines`, but the five tax/proration totals never change from
// what the engine itself computed (a manual adjustment can never silently alter the service base,
// GST or TDS - only `totalAmountMinorSigned`, the full payout sum, reflects it).
export function versionDerivedFields(
  determination: PayableDeterminationResult,
  lines: PayableLine[],
): Pick<
  PayableVersionDoc,
  "determination" | "lines" | "totalAmountMinorSigned" | "openReviewCodes" | "serviceBaseMinor" | "gstMinor" | "grossInvoiceExpectedMinor" | "tdsMinor" | "expectedNetPaymentMinor" | "calculationRuleVersion"
> {
  return {
    determination: payableDeterminationSchema.parse({ state: determination.state, unresolved: determination.unresolved, blocked: determination.blocked, warnings: determination.warnings }),
    lines,
    totalAmountMinorSigned: totalOfLines(lines),
    openReviewCodes: openReviewCodesOf(determination.unresolved, lines),
    serviceBaseMinor: determination.serviceBaseMinor,
    gstMinor: determination.gstMinor,
    grossInvoiceExpectedMinor: determination.grossInvoiceExpectedMinor,
    tdsMinor: determination.tdsMinor,
    expectedNetPaymentMinor: determination.expectedNetPaymentMinor,
    calculationRuleVersion: determination.calculationRuleVersion,
  };
}

// True when this error is Firestore's ALREADY_EXISTS (gRPC code 6): a tx.create lost a race.
export function isAlreadyExistsError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return candidate?.code === 6 || candidate?.code === "already-exists" || (typeof candidate?.message === "string" && /ALREADY_EXISTS/.test(candidate.message));
}
