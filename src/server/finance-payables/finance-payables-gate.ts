import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { getPayableHeadDoc } from "./firestore";
import {
  financePayablesNotFoundResult,
  financePayablesUnauthorizedResult,
  payableRefSchema,
  type FinancePayablesDenialReason,
  type FinancePayablesErrorResult,
  type PayableCounterpartyType,
  type PayableHeadDoc,
} from "./types";

// Step 15A: the Finance Payables gate. Every service runs this chain, in this order:
//   Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(finance)
//   -> ActionPermission -> RecordScope (LIVE, from the Partner / Vendor doc)
//   -> SensitiveAccess (where relevant) -> lifecycle preconditions (inside the transaction).
// Explicit grants only: no role rank, no wildcard, no minimumRole, and a missing grant fails
// closed. API routes carry no proxy feature gate, so the services (through this file) do
// everything.
//
// The Finance actions a Payable operation can require:
//   manage_payables   prepare / revise a DRAFT Payable, and create one
//   approve_payables  move a Payable to READY_FOR_INVOICE
//   adjust_payables   add or remove a manual financial adjustment (additionally needs the
//                     finance_amounts sensitive category - you cannot set money you may not see)
//   void_payables     void a Payable with a reason
// Viewing needs the `finance` feature alone, with no action - exactly like the Agreements read
// gate. Seeing the exact AMOUNTS additionally needs finance_amounts (see FINANCE_AMOUNTS_CATEGORY).
export type FinancePayableAction = Extract<ActionId, "manage_payables" | "approve_payables" | "adjust_payables" | "void_payables">;

// The canonical sensitive category for "Payable, invoice and payment amounts within Finance"
// (src/server/authz/sensitive-categories.ts). Without it a Payable's figures are withheld from
// every DTO and a manual adjustment is refused.
export const FINANCE_AMOUNTS_CATEGORY = "finance_amounts";

export type FinancePayablesAccessResult = { ok: true } | { ok: false; reason: FinancePayablesDenialReason };

// Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission. Without an `action`
// it is the READ gate ("may this actor use Finance Payables at all"); Record Scope is applied
// separately, per record, below. `actor` is the ActorContext resolved from the verified session +
// users/{uid} doc (inactive/unknown users never resolve one), which IS the Admission step.
export async function requireFinancePayablesAccess(actor: ActorContext | null, action?: FinancePayableAction): Promise<FinancePayablesAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "finance");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  if (action) {
    const hasAction = await canPerformAction(actor, "finance", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }

  return { ok: true };
}

// Exact Payable AMOUNTS (totals, breakdown lines, the snapshot's own figures).
export async function requireAmountsSensitiveAccess(actor: ActorContext): Promise<FinancePayablesAccessResult> {
  const allowed = await canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY);
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}

// --- Counterparty (live Record Scope) ----------------------------------------------------------------------------------
export type AuthorizedPayableCounterparty = {
  type: PayableCounterpartyType;
  ref: string;
  displayName: string;
  scope: { ownerUid: string | null; regionIds: string[]; teamIds: string[]; partnerUid: string | null; vendorUid: string | null };
};

export type LoadAuthorizedCounterpartyResult = { ok: true; authorized: AuthorizedPayableCounterparty } | { ok: false; error: FinancePayablesErrorResult };

// The neutral outcome: a missing, out-of-scope, forged or foreign reference is answered with
// exactly this, so a caller can never learn which one it was.
function neutral(): { ok: false; error: FinancePayablesErrorResult } {
  return { ok: false, error: financePayablesNotFoundResult() };
}

// Live-loads the Partner (isPartnerDocInScope) or Vendor (isVendorDocInScope) the client NAMED and
// applies the actor's Record Scope to it. Never trusts a client-supplied scope, and never
// duplicates canonical Partner / Vendor identity - it only carries the opaque ref forward. It does
// NOT re-run feature/action checks: the calling service has already run
// requireFinancePayablesAccess.
export async function loadAuthorizedPayableCounterparty(actor: ActorContext, type: PayableCounterpartyType, ref: string): Promise<LoadAuthorizedCounterpartyResult> {
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

// --- Payable (gate + head + LIVE counterparty scope) ----------------------------------------------------------------------
export type AuthorizedPayable = {
  head: PayableHeadDoc;
  displayName: string;
  // The LIVE scope of the counterparty (never the head's stored snapshot).
  liveScope: AuthorizedPayableCounterparty["scope"];
};

export type LoadAuthorizedPayableResult = { ok: true; authorized: AuthorizedPayable } | { ok: false; error: FinancePayablesErrorResult };

// Runs the access gate, loads the head, and re-verifies the CURRENT scope of the head's Partner /
// Vendor - the head's own stored scope snapshot is never trusted (it only serves bounded list
// queries). Knowing a payableRef never grants access: a malformed, missing or out-of-scope Payable
// (or one whose counterparty has vanished) all return the SAME neutral not_found; only
// feature/action denial is reported as unauthorized.
export async function loadAuthorizedPayable(actor: ActorContext | null, payableRef: string, action?: FinancePayableAction): Promise<LoadAuthorizedPayableResult> {
  const access = await requireFinancePayablesAccess(actor, action);
  if (!access.ok) return { ok: false, error: financePayablesUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: financePayablesUnauthorizedResult("not_authenticated") };

  if (!payableRefSchema.safeParse(payableRef).success) return neutral();
  const head = await getPayableHeadDoc(payableRef);
  if (!head) return neutral();

  const loaded = await loadAuthorizedPayableCounterparty(actor, head.counterpartyType, head.counterpartyRef);
  if (!loaded.ok) return loaded;
  const liveUid = head.counterpartyType === "PARTNER" ? loaded.authorized.scope.partnerUid : loaded.authorized.scope.vendorUid;
  const headUid = head.counterpartyType === "PARTNER" ? head.partnerUid : head.vendorUid;
  if (liveUid !== headUid) return neutral();

  return { ok: true, authorized: { head, displayName: loaded.authorized.displayName, liveScope: loaded.authorized.scope } };
}
