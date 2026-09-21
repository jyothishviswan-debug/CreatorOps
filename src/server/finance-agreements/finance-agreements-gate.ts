import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { canAccessSensitive } from "@/server/authz/sensitive";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getPartnerAccountDocsByRefs, getPartnerDocByRef } from "@/server/partners/firestore";
import { isPartnerDocInScope } from "@/server/partners/partners-gate";
import type { PartnerAccountDoc, PartnerDoc } from "@/server/partners/types";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { getVendorDocByRef } from "@/server/vendors/firestore";
import { isVendorDocInScope } from "@/server/vendors/vendors-gate";
import type { VendorDoc } from "@/server/vendors/types";

import { getAgreementHeadDoc } from "./firestore";
import {
  agreementRefSchema,
  financeAgreementsNotFoundResult,
  financeAgreementsUnauthorizedResult,
  type AgreementCounterparty,
  type AgreementCounterpartyInput,
  type AgreementHeadDoc,
  type AgreementScopeSnapshot,
  type CounterpartyType,
  type FinanceAgreementsDenialReason,
  type FinanceAgreementsErrorResult,
} from "./types";

// Step 14A: the Finance Agreements gate. Every service runs this chain, in this order:
//   Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(finance)
//   -> ActionPermission -> RecordScope (LIVE, from the Partner / Vendor doc)
//   -> SensitiveAccess (where relevant) -> lifecycle preconditions (inside the transaction).
// Explicit grants only: no role rank, no wildcard, no minimumRole. API routes carry no proxy
// feature gate, so the services (through this file) do everything.

// The Finance actions an Agreement operation can require. `manage_agreements` prepares (draft,
// decide, extract, confirm); `activate_agreements` governs the lifecycle (activate, revise,
// suspend, resume, end).
export type FinanceAgreementAction = Extract<ActionId, "manage_agreements" | "activate_agreements">;

export const FINANCE_CONTRACTS_CATEGORY = "finance_contracts";
// Identity VALUES additionally need the OWNING boundary's own category.
export const IDENTITY_CATEGORY_BY_COUNTERPARTY: Record<CounterpartyType, string> = { PARTNER: "payment_details", VENDOR: "vendor_payment_details" };

export type FinanceAgreementsAccessResult = { ok: true } | { ok: false; reason: FinanceAgreementsDenialReason };

// Authentication -> Admission -> FeatureAccess(finance) -> ActionPermission. Without an
// `action` it is the READ gate ("may this actor use Finance Agreements at all"); Record Scope
// is applied separately, per record, below. `actor` is the ActorContext resolved from the
// verified session + users/{uid} doc (inactive/unknown users never resolve one), which IS the
// Admission step.
export async function requireFinanceAgreementsAccess(actor: ActorContext | null, action?: FinanceAgreementAction): Promise<FinanceAgreementsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };

  const hasFeature = await canAccessFeature(actor, "finance");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };

  if (action) {
    const hasAction = await canPerformAction(actor, "finance", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }

  return { ok: true };
}

// Raw contract snippets/locators of extracted fields and the restricted extraction record.
export async function requireContractSensitiveAccess(actor: ActorContext): Promise<FinanceAgreementsAccessResult> {
  const allowed = await canAccessSensitive(actor, FINANCE_CONTRACTS_CATEGORY);
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}

// Restricted identity VALUES (and per-component KYC detail): payment_details for a Partner
// counterparty, vendor_payment_details for a Vendor counterparty. Independent of
// finance_contracts - reading an extracted identity value needs BOTH.
export async function requireIdentitySensitiveAccess(actor: ActorContext, counterpartyType: CounterpartyType): Promise<FinanceAgreementsAccessResult> {
  const allowed = await canAccessSensitive(actor, IDENTITY_CATEGORY_BY_COUNTERPARTY[counterpartyType]);
  return allowed ? { ok: true } : { ok: false, reason: "sensitive_denied" };
}

// --- Counterparty (live Record Scope) --------------------------------------------------------------------------------------
type PartnerCounterparty = Extract<AgreementCounterparty, { type: "PARTNER" }>;
type VendorCounterparty = Extract<AgreementCounterparty, { type: "VENDOR" }>;

export type AuthorizedCounterparty =
  | { type: "PARTNER"; counterparty: PartnerCounterparty; scope: AgreementScopeSnapshot; displayName: string; partner: PartnerDoc; accounts: PartnerAccountDoc[] }
  | { type: "VENDOR"; counterparty: VendorCounterparty; scope: AgreementScopeSnapshot; displayName: string; vendor: VendorDoc };

export type LoadAuthorizedCounterpartyResult = { ok: true; authorized: AuthorizedCounterparty } | { ok: false; error: FinanceAgreementsErrorResult };

// The neutral outcome: a missing, out-of-scope, forged or foreign reference is answered with
// exactly this, so a caller can never learn which one it was.
function neutral(): { ok: false; error: FinanceAgreementsErrorResult } {
  return { ok: false, error: financeAgreementsNotFoundResult() };
}

// Live-loads the Partner (isPartnerDocInScope; scope grants key on the doc `uid`) or Vendor
// (isVendorDocInScope) the client NAMED and applies the actor's Record Scope to it. Never
// trusts client-supplied scope. It does NOT re-run feature/action checks: the calling service
// has already run requireFinanceAgreementsAccess.
//
// PARTNER: any partnerAccountRefs must exist AND belong to that Partner (a forged or foreign
// account ref is the same neutral outcome). platformScope is derived HERE from those accounts
// with the shared normalizePlatformIdentifier - never client-supplied. One Partner with an
// Instagram and a YouTube account stays ONE Partner identity (platformScope
// ["instagram","youtube"]). A Vendor agreement never consults a Partner's Vendor link.
export async function loadAuthorizedCounterparty(actor: ActorContext, input: AgreementCounterpartyInput): Promise<LoadAuthorizedCounterpartyResult> {
  const grants = await getActorScopeGrants(actor);

  if (input.type === "VENDOR") {
    const vendor = await getVendorDocByRef(input.vendorRef);
    if (!vendor || !isVendorDocInScope(grants, actor.uid, vendor)) return neutral();
    return {
      ok: true,
      authorized: {
        type: "VENDOR",
        counterparty: { type: "VENDOR", vendorRef: vendor.vendorRef },
        scope: { ownerUid: vendor.ownerUid, regionIds: vendor.regionIds, teamIds: vendor.teamIds, partnerUid: null, vendorUid: vendor.uid },
        displayName: vendor.displayName,
        vendor,
      },
    };
  }

  const partner = await getPartnerDocByRef(input.partnerRef);
  if (!partner || !isPartnerDocInScope(grants, actor.uid, partner)) return neutral();

  const requestedRefs = [...new Set(input.partnerAccountRefs ?? [])];
  const accounts: PartnerAccountDoc[] = [];
  if (requestedRefs.length > 0) {
    const found = await getPartnerAccountDocsByRefs(requestedRefs);
    for (const ref of requestedRefs) {
      const account = found.get(ref);
      if (!account || account.partnerRef !== partner.partnerRef) return neutral();
      accounts.push(account);
    }
  }
  const platformScope = [...new Set(accounts.map((account) => normalizePlatformIdentifier(account.platform)))].sort();

  return {
    ok: true,
    authorized: {
      type: "PARTNER",
      counterparty: { type: "PARTNER", partnerRef: partner.partnerRef, partnerAccountRefs: accounts.map((account) => account.partnerAccountRef), platformScope },
      scope: { ownerUid: partner.ownerUid, regionIds: partner.regionIds, teamIds: partner.teamIds, partnerUid: partner.uid, vendorUid: null },
      displayName: partner.displayName,
      partner,
      accounts,
    },
  };
}

// --- Agreement (gate + head + LIVE counterparty scope) ----------------------------------------------------------------------
export type AuthorizedAgreement = {
  head: AgreementHeadDoc;
  counterpartyType: CounterpartyType;
  displayName: string;
  // The LIVE scope of the counterparty (never the head's stored snapshot).
  liveScope: AgreementScopeSnapshot;
};

export type LoadAuthorizedAgreementResult = { ok: true; authorized: AuthorizedAgreement } | { ok: false; error: FinanceAgreementsErrorResult };

// Runs the access gate, loads the head, and re-verifies the CURRENT scope of the head's
// Partner/Vendor - the head's own stored scope snapshot is never trusted (it only serves
// bounded list queries). Knowing an agreementRef never grants access: a malformed, missing or
// out-of-scope Agreement (or one whose counterparty has vanished) all return the SAME
// neutral not_found; only feature/action denial is reported as unauthorized.
export async function loadAuthorizedAgreement(actor: ActorContext | null, agreementRef: string, action?: FinanceAgreementAction): Promise<LoadAuthorizedAgreementResult> {
  const access = await requireFinanceAgreementsAccess(actor, action);
  if (!access.ok) return { ok: false, error: financeAgreementsUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: financeAgreementsUnauthorizedResult("not_authenticated") };

  if (!agreementRefSchema.safeParse(agreementRef).success) return neutral();
  const head = await getAgreementHeadDoc(agreementRef);
  if (!head) return neutral();

  const grants = await getActorScopeGrants(actor);
  if (head.counterparty.type === "VENDOR") {
    const vendor = await getVendorDocByRef(head.counterparty.vendorRef);
    if (!vendor || vendor.uid !== head.vendorUid || !isVendorDocInScope(grants, actor.uid, vendor)) return neutral();
    return {
      ok: true,
      authorized: { head, counterpartyType: "VENDOR", displayName: vendor.displayName, liveScope: { ownerUid: vendor.ownerUid, regionIds: vendor.regionIds, teamIds: vendor.teamIds, partnerUid: null, vendorUid: vendor.uid } },
    };
  }

  const partner = await getPartnerDocByRef(head.counterparty.partnerRef);
  if (!partner || partner.uid !== head.partnerUid || !isPartnerDocInScope(grants, actor.uid, partner)) return neutral();
  return {
    ok: true,
    authorized: { head, counterpartyType: "PARTNER", displayName: partner.displayName, liveScope: { ownerUid: partner.ownerUid, regionIds: partner.regionIds, teamIds: partner.teamIds, partnerUid: partner.uid, vendorUid: null } },
  };
}
