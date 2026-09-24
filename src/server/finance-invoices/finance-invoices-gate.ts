import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getActorScopeGrants } from "@/server/authz/scope";
import { canAccessSensitive } from "@/server/authz/sensitive";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";

import { getInvoiceHeadDoc } from "./firestore";
import {
  financeInvoicesNotFoundResult,
  financeInvoicesUnauthorizedResult,
  invoiceRefSchema,
  type FinanceInvoicesDenialReason,
  type FinanceInvoicesErrorResult,
  type InvoiceCounterpartyType,
  type InvoiceHeadDoc,
} from "./types";

// Step 16A: the Finance Invoices gate. Every service runs this chain, in this order:
//   Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(finance)
//   -> ActionPermission -> RecordScope (LIVE, from the Partner / Vendor doc)
//   -> SensitiveAccess (where relevant) -> lifecycle preconditions (inside the transaction).
// Explicit grants only: no role rank, no wildcard, no minimumRole, and a missing grant fails
// closed. API routes carry no proxy feature gate, so the services (through this file) do
// everything.
//
// The Finance actions an Invoice operation can require:
//   manage_invoices             create/revise a DRAFT (or a reopened) Invoice, attach its document,
//                                submit it
//   approve_invoices            approve or reject a SUBMITTED Invoice
//   void_invoices                void an Invoice with a reason
//   override_invoice_mismatch   accept a legitimate Invoice/Payable amount mismatch (additionally
//                                needs the finance_amounts sensitive category - the same "you cannot
//                                accept a mismatch in money you may not see" discipline Payables'
//                                own manual-adjustment action already applies)
//   resolve_invoice_payee_mismatch  Step 16C: accept the Invoice as belonging to the expected Payable
//                                counterparty despite a payee identity mismatch/review (also needs
//                                finance_amounts) - its own narrow action, deliberately never folded
//                                into override_invoice_mismatch (a distinct decision - section 11).
// Viewing needs the `finance` feature alone, with no action. Seeing the exact AMOUNTS additionally
// needs finance_amounts. Because reconciling an Invoice against its pinned Payable is fundamentally
// a money comparison, every command that creates or revises Invoice content (preview, create,
// revise, attach document, reconcile) ALSO requires finance_amounts - the same discipline Payables
// applies to a manual adjustment, extended here to the whole authoring surface since an Invoice IS a
// money record from the moment it exists.
export type FinanceInvoiceAction = Extract<ActionId, "manage_invoices" | "approve_invoices" | "void_invoices" | "override_invoice_mismatch" | "resolve_invoice_payee_mismatch">;

// The canonical sensitive category for "Payable, invoice and payment amounts within Finance"
// (src/server/authz/sensitive-categories.ts) - the SAME category Payables uses, by design: an
// actor's amounts trust does not change module to module within Finance.
export const FINANCE_AMOUNTS_CATEGORY = "finance_amounts";

export type FinanceInvoicesAccessResult = { ok: true } | { ok: false; reason: FinanceInvoicesDenialReason };

// Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission. Without an `action` it
// is the READ gate ("may this actor use Finance Invoices at all"); Record Scope is applied
// separately, per record, below.
export async function requireFinanceInvoicesAccess(actor: ActorContext | null, action?: FinanceInvoiceAction): Promise<FinanceInvoicesAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "finance");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  if (action) {
    const hasAction = await canPerformAction(actor, "finance", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }

  return { ok: true };
}

// Exact Invoice AMOUNTS (declared totals, tax lines, the pinned Payable's expected total).
export async function requireAmountsSensitiveAccess(actor: ActorContext): Promise<FinanceInvoicesAccessResult> {
  const allowed = await canAccessSensitive(actor, FINANCE_AMOUNTS_CATEGORY);
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}

// A command that authors Invoice content: needs BOTH the exact action and finance_amounts.
export async function requireAuthoringAccess(actor: ActorContext | null, action: FinanceInvoiceAction): Promise<FinanceInvoicesAccessResult> {
  const access = await requireFinanceInvoicesAccess(actor, action);
  if (!access.ok) return access;
  return requireAmountsSensitiveAccess(actor!);
}

// --- Counterparty (live Record Scope) ----------------------------------------------------------------------------------
export type AuthorizedInvoiceCounterparty = {
  type: InvoiceCounterpartyType;
  ref: string;
  displayName: string;
  scope: { ownerUid: string | null; regionIds: string[]; teamIds: string[]; partnerUid: string | null; vendorUid: string | null };
};

export type LoadAuthorizedCounterpartyResult = { ok: true; authorized: AuthorizedInvoiceCounterparty } | { ok: false; error: FinanceInvoicesErrorResult };

// The neutral outcome: a missing, out-of-scope, forged or foreign reference is answered with
// exactly this, so a caller can never learn which one it was.
function neutral(): { ok: false; error: FinanceInvoicesErrorResult } {
  return { ok: false, error: financeInvoicesNotFoundResult() };
}

// Live-loads the Partner or Vendor the Payable named and applies the actor's Record Scope to it.
// Never trusts a client-supplied scope. Does NOT re-run feature/action checks - the calling service
// has already run requireFinanceInvoicesAccess.
export async function loadAuthorizedInvoiceCounterparty(actor: ActorContext, type: InvoiceCounterpartyType, ref: string): Promise<LoadAuthorizedCounterpartyResult> {
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

// --- Invoice (gate + head + LIVE counterparty scope) ----------------------------------------------------------------------
export type AuthorizedInvoice = {
  head: InvoiceHeadDoc;
  displayName: string;
  // The LIVE scope of the counterparty (never the head's stored snapshot).
  liveScope: AuthorizedInvoiceCounterparty["scope"];
};

export type LoadAuthorizedInvoiceResult = { ok: true; authorized: AuthorizedInvoice } | { ok: false; error: FinanceInvoicesErrorResult };

// Runs the access gate, loads the head, and re-verifies the CURRENT scope of the head's Partner /
// Vendor - the head's own stored scope snapshot is never trusted (it only serves bounded list
// queries). Knowing an invoiceRef never grants access: a malformed, missing or out-of-scope Invoice
// (or one whose counterparty has vanished) all return the SAME neutral not_found; only
// feature/action denial is reported as unauthorized.
export async function loadAuthorizedInvoice(actor: ActorContext | null, invoiceRef: string, action?: FinanceInvoiceAction): Promise<LoadAuthorizedInvoiceResult> {
  const access = await requireFinanceInvoicesAccess(actor, action);
  if (!access.ok) return { ok: false, error: financeInvoicesUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: financeInvoicesUnauthorizedResult("not_authenticated") };

  if (!invoiceRefSchema.safeParse(invoiceRef).success) return neutral();
  const head = await getInvoiceHeadDoc(invoiceRef);
  if (!head) return neutral();

  const loaded = await loadAuthorizedInvoiceCounterparty(actor, head.counterpartyType, head.counterpartyRef);
  if (!loaded.ok) return loaded;
  const liveUid = head.counterpartyType === "PARTNER" ? loaded.authorized.scope.partnerUid : loaded.authorized.scope.vendorUid;
  const headUid = head.counterpartyType === "PARTNER" ? head.partnerUid : head.vendorUid;
  if (liveUid !== headUid) return neutral();

  return { ok: true, authorized: { head, displayName: loaded.authorized.displayName, liveScope: loaded.authorized.scope } };
}
