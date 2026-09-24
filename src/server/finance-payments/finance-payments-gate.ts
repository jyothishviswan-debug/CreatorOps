import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { getPaymentHeadDoc } from "./firestore";
import {
  financePaymentsNotFoundResult,
  financePaymentsUnauthorizedResult,
  paymentRefSchema,
  type FinancePaymentsDenialReason,
  type FinancePaymentsErrorResult,
  type PaymentCounterpartyType,
  type PaymentHeadDoc,
} from "./types";

// Step 17A: the Finance Payments gate. Mirrors src/server/finance-invoices/finance-invoices-gate.ts
// exactly. Every service runs this chain, in this order:
//   Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(finance)
//   -> ActionPermission -> RecordScope (LIVE, from the Partner / Vendor doc)
//   -> SensitiveAccess (where relevant) -> lifecycle preconditions (inside the transaction).
// Explicit grants only: no role rank, no wildcard, no minimumRole, and a missing grant fails
// closed. API routes carry no proxy feature gate, so the services (through this file) do
// everything.
//
// The Finance actions a Payment operation can require:
//   manage_payments           create/revise a DRAFT Payment, record a transfer, reopen a FAILED one
//   confirm_payments          confirm a RECORDED Payment (the only transition that counts toward
//                              settlement)
//   void_payments              void a Payment with a reason
//   override_payment_overage  accept an overpayment past the expected net payment (additionally
//                              needs the finance_amounts sensitive category - the same "you cannot
//                              override money you may not see" discipline Invoices' own mismatch-
//                              override action already applies)
// Viewing needs the `finance` feature alone, with no action. Seeing the exact AMOUNTS additionally
// needs finance_amounts. Every command that creates, revises or reads the money on a Payment
// requires finance_amounts too - the same discipline Invoices applies to its own authoring surface,
// since a Payment IS a money record from the moment it exists.
export type FinancePaymentAction = Extract<ActionId, "manage_payments" | "confirm_payments" | "void_payments" | "override_payment_overage">;

// The canonical sensitive category for "Payable, invoice and payment amounts within Finance"
// (src/server/authz/sensitive-categories.ts) - the SAME category Payables/Invoices use, by design:
// an actor's amounts trust does not change module to module within Finance.
export const FINANCE_AMOUNTS_CATEGORY = "finance_amounts";

export type FinancePaymentsAccessResult = { ok: true } | { ok: false; reason: FinancePaymentsDenialReason };

// Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission. Without an `action` it
// is the READ gate ("may this actor use Finance Payments at all"); Record Scope is applied
// separately, per record, below.
export async function requireFinancePaymentsAccess(actor: ActorContext | null, action?: FinancePaymentAction): Promise<FinancePaymentsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "finance");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  if (action) {
    const hasAction = await canPerformAction(actor, "finance", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }

  return { ok: true };
}

// Exact Payment AMOUNTS (declared amount, expected net payment, settlement totals).
export async function requireAmountsSensitiveAccess(actor: ActorContext): Promise<FinancePaymentsAccessResult> {
  const allowed = await canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY);
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}

// A command that authors Payment content: needs BOTH the exact action and finance_amounts.
export async function requireAuthoringAccess(actor: ActorContext | null, action: FinancePaymentAction): Promise<FinancePaymentsAccessResult> {
  const access = await requireFinancePaymentsAccess(actor, action);
  if (!access.ok) return access;
  return requireAmountsSensitiveAccess(actor!);
}

// --- Counterparty (live Record Scope) ----------------------------------------------------------------------------------
export type AuthorizedPaymentCounterparty = {
  type: PaymentCounterpartyType;
  ref: string;
  displayName: string;
  scope: { ownerUid: string | null; regionIds: string[]; teamIds: string[]; partnerUid: string | null; vendorUid: string | null };
};

export type LoadAuthorizedCounterpartyResult = { ok: true; authorized: AuthorizedPaymentCounterparty } | { ok: false; error: FinancePaymentsErrorResult };

// The neutral outcome: a missing, out-of-scope, forged or foreign reference is answered with
// exactly this, so a caller can never learn which one it was.
function neutral(): { ok: false; error: FinancePaymentsErrorResult } {
  return { ok: false, error: financePaymentsNotFoundResult() };
}

// Live-loads the Partner or Vendor the Invoice named and applies the actor's Record Scope to it.
// Never trusts a client-supplied scope. Does NOT re-run feature/action checks - the calling service
// has already run requireFinancePaymentsAccess.
export async function loadAuthorizedPaymentCounterparty(actor: ActorContext, type: PaymentCounterpartyType, ref: string): Promise<LoadAuthorizedCounterpartyResult> {
  const grants = await getActorScopeGrants(actor);

  if (type === "VENDOR") {
    const vendor = await getVendorDocByRef(ref);
    if (!vendor || !isVendorDocInScope(grants, actor.uid, vendor)) return neutral();
    return {
      ok: true,
      authorized: { type: "VENDOR", ref: vendor.vendorRef, displayName: vendor.displayName, scope: { ownerUid: vendor.ownerUid, regionIds: vendor.regionIds, teamIds: vendor.teamIds, partnerUid: null, vendorUid: vendor.uid } },
    };
  }

  const partner = await getPartnerDocByRef(ref);
  if (!partner || !isPartnerDocInScope(grants, actor.uid, partner)) return neutral();
  return {
    ok: true,
    authorized: { type: "PARTNER", ref: partner.partnerRef, displayName: partner.displayName, scope: { ownerUid: partner.ownerUid, regionIds: partner.regionIds, teamIds: partner.teamIds, partnerUid: partner.uid, vendorUid: null } },
  };
}

// --- Payment (gate + head + LIVE counterparty scope) ----------------------------------------------------------------------
export type AuthorizedPayment = {
  head: PaymentHeadDoc;
  displayName: string;
  // The LIVE scope of the counterparty (never the head's stored snapshot).
  liveScope: AuthorizedPaymentCounterparty["scope"];
};

export type LoadAuthorizedPaymentResult = { ok: true; authorized: AuthorizedPayment } | { ok: false; error: FinancePaymentsErrorResult };

// Runs the access gate, loads the head, and re-verifies the CURRENT scope of the head's Partner /
// Vendor - the head's own stored scope snapshot is never trusted. Knowing a paymentRef never grants
// access: a malformed, missing or out-of-scope Payment (or one whose counterparty has vanished) all
// return the SAME neutral not_found; only feature/action denial is reported as unauthorized.
export async function loadAuthorizedPayment(actor: ActorContext | null, paymentRef: string, action?: FinancePaymentAction): Promise<LoadAuthorizedPaymentResult> {
  const access = await requireFinancePaymentsAccess(actor, action);
  if (!access.ok) return { ok: false, error: financePaymentsUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: financePaymentsUnauthorizedResult("not_authenticated") };

  if (!paymentRefSchema.safeParse(paymentRef).success) return neutral();
  const head = await getPaymentHeadDoc(paymentRef);
  if (!head) return neutral();

  const loaded = await loadAuthorizedPaymentCounterparty(actor, head.counterpartyType, head.counterpartyRef);
  if (!loaded.ok) return loaded;
  const liveUid = head.counterpartyType === "PARTNER" ? loaded.authorized.scope.partnerUid : loaded.authorized.scope.vendorUid;
  const headUid = head.counterpartyType === "PARTNER" ? head.partnerUid : head.vendorUid;
  if (liveUid !== headUid) return neutral();

  return { ok: true, authorized: { head, displayName: loaded.authorized.displayName, liveScope: loaded.authorized.scope } };
}
