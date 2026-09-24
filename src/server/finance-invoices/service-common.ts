import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";

import { toInvoiceHeadDto, toInvoiceVersionDto, toInvoiceVersionSummaryDto, type InvoiceDetailDto } from "./client-dto";
import { listInvoiceVersionDocs } from "./firestore";
import { loadAuthorizedInvoice, requireAmountsSensitiveAccess, requireFinanceInvoicesAccess, type AuthorizedInvoice, type FinanceInvoiceAction } from "./finance-invoices-gate";
import {
  financeInvoicesInvalidInputResult,
  financeInvoicesUnauthorizedResult,
  invoiceHeadDisplaySchema,
  type FinanceInvoicesErrorResult,
  type InvoiceHeadDisplay,
  type InvoiceHeadDoc,
  type InvoiceVersionDoc,
} from "./types";

// Step 16A: small helpers shared by the Invoice read / mutation services and the lifecycle service.
// Nothing here writes; every write lives in the services' own transactions. Mirrors Payables' own
// service-common.ts exactly.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

// The head's own scope fields are a point-in-time copy of the LIVE Partner's / Vendor's scope,
// refreshed on every mutation. They only serve bounded scoped list queries.
export function scopeFieldsOf(scope: AuthorizedInvoice["liveScope"]): Pick<InvoiceHeadDoc, "ownerUid" | "regionIds" | "teamIds" | "partnerUid" | "vendorUid"> {
  return { ownerUid: scope.ownerUid, regionIds: scope.regionIds, teamIds: scope.teamIds, partnerUid: scope.partnerUid, vendorUid: scope.vendorUid };
}

export type AuthorizedCommand<T> = { ok: true; input: T; authorized: AuthorizedInvoice } | { ok: false; error: FinanceInvoicesErrorResult };

// The chain every Invoice command starts with, in order: Authentication -> Admission ->
// FeatureAccess(finance) -> ActionPermission -> input shape -> live RecordScope (the head's
// Partner / Vendor). Unauthenticated / unauthorized callers learn nothing about the input's
// validity or the record's existence; a missing / out-of-scope / forged invoiceRef is the same
// neutral not_found.
export async function authorizeInvoiceCommand<T extends { invoiceRef: string }>(
  actor: ActorContext | null,
  action: FinanceInvoiceAction,
  schema: z.ZodType<T, unknown>,
  rawInput: unknown,
): Promise<AuthorizedCommand<T>> {
  const access = await requireFinanceInvoicesAccess(actor, action);
  if (!access.ok) return { ok: false, error: financeInvoicesUnauthorizedResult(access.reason) };

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: financeInvoicesInvalidInputResult(formatIssues(parsed.error)) };

  const loaded = await loadAuthorizedInvoice(actor, parsed.data.invoiceRef, action);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, input: parsed.data, authorized: loaded.authorized };
}

// Head + bounded version summaries + one version's full detail. Every response - reads AND
// mutation results - is built through here. Exact money figures need the `finance_amounts`
// sensitive category (checked here, not in the DTO): without it every figure is null and the
// response says so with amountsVisible:false.
export async function buildInvoiceDetailDto(actor: ActorContext, head: InvoiceHeadDoc, displayName: string | null, selected: InvoiceVersionDoc | null): Promise<InvoiceDetailDto> {
  const [versions, amounts] = await Promise.all([listInvoiceVersionDocs(head.invoiceRef), requireAmountsSensitiveAccess(actor)]);
  const options = { amountsVisible: amounts.ok };
  return {
    head: toInvoiceHeadDto(head, displayName, options),
    versions: versions.versions.map((doc) => toInvoiceVersionSummaryDto(doc, options)),
    hasMoreVersions: versions.hasMore,
    selectedVersion: selected ? toInvoiceVersionDto(selected, options, head.payeeMismatchOverride) : null,
    amountsVisible: amounts.ok,
  };
}

// The head's list projection, recomputed from the version that is now the latest. Never
// authorization and never financial truth - the version documents are.
export function buildInvoiceHeadDisplay(input: { counterpartyName: string; version: InvoiceVersionDoc; projectedAt: string }): InvoiceHeadDisplay {
  return invoiceHeadDisplaySchema.parse({
    counterpartyName: input.counterpartyName,
    counterpartyNameLower: input.counterpartyName.toLocaleLowerCase(),
    declaredTotalMinor: input.version.declaredTotalMinor,
    reconciliationState: input.version.reconciliation.state,
    externalInvoiceNumber: input.version.externalInvoiceNumber,
    projectedAt: input.projectedAt,
  });
}

// True when this error is Firestore's ALREADY_EXISTS (gRPC code 6): a tx.create lost a race.
export function isAlreadyExistsError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return candidate?.code === 6 || candidate?.code === "already-exists" || (typeof candidate?.message === "string" && /ALREADY_EXISTS/.test(candidate.message));
}
