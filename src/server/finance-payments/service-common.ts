import type { z } from "zod";

import type { ActorContext } from "@/server/authz/types";

import { toPaymentHeadDto, toPaymentVersionDto, toPaymentVersionSummaryDto, type PaymentDetailDto } from "./client-dto";
import { listPaymentVersionDocs } from "./firestore";
import { loadAuthorizedPayment, requireAmountsSensitiveAccess, requireFinancePaymentsAccess, type AuthorizedPayment, type FinancePaymentAction } from "./finance-payments-gate";
import { financePaymentsInvalidInputResult, financePaymentsUnauthorizedResult, paymentHeadDisplaySchema, type FinancePaymentsErrorResult, type PaymentHeadDisplay, type PaymentHeadDoc, type PaymentVersionDoc } from "./types";

// Step 17A: small helpers shared by the Payment read / mutation services and the lifecycle
// service. Nothing here writes; every write lives in the services' own transactions. Mirrors
// src/server/finance-invoices/service-common.ts exactly.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

// The head's own scope fields are a point-in-time copy of the LIVE Partner's / Vendor's scope,
// refreshed on every mutation. They only serve bounded scoped list queries.
export function scopeFieldsOf(scope: AuthorizedPayment["liveScope"]): Pick<PaymentHeadDoc, "ownerUid" | "regionIds" | "teamIds" | "partnerUid" | "vendorUid"> {
  return { ownerUid: scope.ownerUid, regionIds: scope.regionIds, teamIds: scope.teamIds, partnerUid: scope.partnerUid, vendorUid: scope.vendorUid };
}

export type AuthorizedCommand<T> = { ok: true; input: T; authorized: AuthorizedPayment } | { ok: false; error: FinancePaymentsErrorResult };

// The chain every Payment command starts with, in order: Authentication -> Admission ->
// FeatureAccess(finance) -> ActionPermission -> input shape -> live RecordScope (the head's
// Partner / Vendor).
export async function authorizePaymentCommand<T extends { paymentRef: string }>(
  actor: ActorContext | null,
  action: FinancePaymentAction,
  schema: z.ZodType<T, unknown>,
  rawInput: unknown,
): Promise<AuthorizedCommand<T>> {
  const access = await requireFinancePaymentsAccess(actor, action);
  if (!access.ok) return { ok: false, error: financePaymentsUnauthorizedResult(access.reason) };

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: financePaymentsInvalidInputResult(formatIssues(parsed.error)) };

  const loaded = await loadAuthorizedPayment(actor, parsed.data.paymentRef, action);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, input: parsed.data, authorized: loaded.authorized };
}

// Head + bounded version summaries + one version's full detail. Every response - reads AND
// mutation results - is built through here. Exact money figures need the `finance_amounts`
// sensitive category.
export async function buildPaymentDetailDto(actor: ActorContext, head: PaymentHeadDoc, displayName: string | null, selected: PaymentVersionDoc | null): Promise<PaymentDetailDto> {
  const [versions, amounts] = await Promise.all([listPaymentVersionDocs(head.paymentRef), requireAmountsSensitiveAccess(actor)]);
  const options = { amountsVisible: amounts.ok };
  return {
    head: toPaymentHeadDto(head, displayName, options),
    versions: versions.versions.map((doc) => toPaymentVersionSummaryDto(doc, options)),
    hasMoreVersions: versions.hasMore,
    selectedVersion: selected ? toPaymentVersionDto(selected, options) : null,
    amountsVisible: amounts.ok,
  };
}

// The head's list projection, recomputed from the version that is now the latest.
export function buildPaymentHeadDisplay(input: { counterpartyName: string; version: PaymentVersionDoc; status: PaymentHeadDoc["status"]; projectedAt: string }): PaymentHeadDisplay {
  return paymentHeadDisplaySchema.parse({
    counterpartyName: input.counterpartyName,
    counterpartyNameLower: input.counterpartyName.toLocaleLowerCase(),
    amountMinor: input.version.amountMinor,
    status: input.status,
    projectedAt: input.projectedAt,
  });
}

// True when this error is Firestore's ALREADY_EXISTS (gRPC code 6): a tx.create lost a race.
export function isAlreadyExistsError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return candidate?.code === 6 || candidate?.code === "already-exists" || (typeof candidate?.message === "string" && /ALREADY_EXISTS/.test(candidate.message));
}
