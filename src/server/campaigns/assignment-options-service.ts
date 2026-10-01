// Step 12C.1: the narrow, trusted "what may I choose when creating an
// Assignment from THIS Campaign" read behind the Campaign Detail create
// dialog (GET /api/campaigns/[campaignRef]/assignment-options). Purely
// additive and read-only - it never creates an Assignment, Partner Account,
// Content, token or anything else; the write itself is the already-accepted
// POST /api/assignments (createAssignmentWithOutcome), which independently
// re-validates every choice made here - including (Step 12C.2) the Partner's
// own Record Scope, so this scoped picker is a convenience, never the
// authorization boundary.
//
// Every request:
//  1. reloads the Campaign server-side through getCampaign (feature +
//     Record Scope - the exact same gate as Campaign Detail, never a
//     parallel authorization path). The Campaign is fixed by the URL and can
//     never be replaced by a client payload;
//  2. requires the actor's own assignments.create grant;
//  3. requires the Campaign lifecycle to allow Assignment creation
//     (PLANNED/ACTIVE - the accepted create-eligibility rule).
//
// Two modes, both bounded, never fetch-all:
//  - Partner search (default): the scoped, ACTIVE-only, cursor-bounded
//    listPartners with a name-prefix filter, hard-capped at 10 results, each
//    reduced to a safe {partnerRef, displayName, regionLabels}. Identity is
//    always the opaque partnerRef - never a display name.
//  - `partnerRef`: getPartner (Partner Record Scope enforced) plus THAT
//    Partner's own Partner Accounts (via the accepted scoped
//    listPartnerAccounts), each reduced to a narrow picker DTO that carries
//    NO normalizedIdentity/platformAccountId/followerSnapshot/profileUrl,
//    and the (Campaign, Partner) uniqueness claim so the dialog can show
//    "already exists" BEFORE a create attempt.
import type { ActorContext } from "@/server/authz/types";
import { requireAssignmentInScope, requireAssignmentsAccess } from "@/server/assignments/assignments-gate";
import { evaluatePartnerAccountEligibility, isCampaignStatusAllowingAssignmentCreation, type PartnerAccountUnavailableReason } from "@/server/assignments/create-eligibility";
import { getAssignmentActiveClaim, getAssignmentDocByUid } from "@/server/assignments/firestore";
import type { AssignmentStatus } from "@/server/assignments/types";
import { listPartnerAccounts } from "@/server/partners/partner-account-service";
import { getPartner, listPartners } from "@/server/partners/partner-service";
import type { PartnersErrorResult } from "@/server/partners/types";
import { getVendorDocByRef, listVendorPartnerLinkDocsForVendor } from "@/server/vendors/firestore";
import { listVendors } from "@/server/vendors/vendor-service";

import { getCampaign } from "./campaign-service";
import type { CampaignDto } from "./client-dto";
import { campaignsInvalidInputResult, campaignsUnauthorizedResult, type CampaignsServiceResult } from "./types";

// Hard, documented bound on the Partner picker's result list. Never a
// fetch-all: the query itself is limited to this many rows.
export const MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS = 10;
const MAX_SEARCH_QUERY_LENGTH = 100;
const MAX_REF_LENGTH = 200;

export type AssignmentOptionsCampaignContext = {
  name: string;
  objective: string;
  platforms: Array<{ platform: string; platformLabel: string }>;
  regionIds: string[];
  startDate: string;
  endDate: string;
  // Finding #49: the Campaign's own recorded language requirement, exposed ONLY so the
  // Create-Assignment dialog can surface a non-blocking mismatch against the selected Partners' own
  // known languages - never used to preselect or silently override a Partner's own data.
  languageIds: string[];
};

// Finding #49: `languageIds` is the Partner's own recorded canonical language data (the real,
// per-Partner-known set - there is no separate global language taxonomy in this domain). Safe to
// project as-is: it is already a plain array of short strings, nothing sensitive.
export type AssignmentOptionPartner = { partnerRef: string; displayName: string; regionLabels: string[]; languageIds: string[] };

export type AssignmentOptionAccount = {
  partnerAccountRef: string;
  label: string;
  platform: string;
  platformLabel: string;
  handle: string | null;
  primary: boolean;
  selectable: boolean;
  unavailableReason: PartnerAccountUnavailableReason | null;
};

// `assignmentRef`/`status` are null (and canOpen false) whenever the
// existing Assignment is outside the actor's own Assignment scope - the
// pair is still reported as taken (so a duplicate is never attempted) but an
// out-of-scope Assignment's identity is never leaked.
export type AssignmentOptionsExistingAssignment = { assignmentRef: string | null; status: AssignmentStatus | null; canOpen: boolean };

export type AssignmentOptionsSelectedPartner = AssignmentOptionPartner & {
  accounts: AssignmentOptionAccount[];
  existingAssignment: AssignmentOptionsExistingAssignment | null;
};

// Findings #40 (user-decided): Through-Vendor mode's own picker DTOs - a Vendor search result, and one
// of that Vendor's ACTIVE-linked Partners (real relationship evidence, never a free-typed claim).
export type AssignmentOptionVendor = { vendorRef: string; displayName: string };

export type AssignmentCreateOptionsDto = {
  campaign: AssignmentOptionsCampaignContext;
  // Populated in Partner-search mode; empty when `partnerRef` was supplied.
  partners: AssignmentOptionPartner[];
  hasMorePartners: boolean;
  // Populated only when `partnerRef` was supplied.
  selectedPartner: AssignmentOptionsSelectedPartner | null;
  // Populated only when `vq` was supplied (Through-Vendor mode's own Vendor search).
  vendors: AssignmentOptionVendor[];
  // Populated only when `vendorRef` was supplied: that Vendor's own ACTIVE, ACTIVE-linked Partners.
  vendorPartners: AssignmentOptionPartner[];
};

// ---- Pure shaping helpers (unit-tested; no I/O) -------------------------

// Display-only title-casing of a normalized platform identifier - the
// STORED/normalized value itself is always returned alongside it.
export function platformDisplayLabel(platform: string): string {
  return platform.length > 0 ? platform[0]!.toUpperCase() + platform.slice(1) : platform;
}

export function buildCampaignContext(campaign: Pick<CampaignDto, "name" | "objective" | "platforms" | "regionIds" | "startDate" | "endDate" | "criteria">): AssignmentOptionsCampaignContext {
  return {
    name: campaign.name,
    objective: campaign.objective,
    platforms: campaign.platforms.map((platform) => ({ platform, platformLabel: platformDisplayLabel(platform) })),
    regionIds: campaign.regionIds,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    languageIds: campaign.criteria.languageIds,
  };
}

// Finding #49: fixes toSafePartnerOption's own root-cause bug - languageIds now reaches the picker
// (still only these four fields ever leave the server for a Partner here - never email/phone/
// legalName/tier/owner or anything else).
export function toSafePartnerOption(partner: { partnerRef: string; displayName: string; regionIds: string[]; languageIds: string[] }): AssignmentOptionPartner {
  return { partnerRef: partner.partnerRef, displayName: partner.displayName, regionLabels: partner.regionIds, languageIds: partner.languageIds };
}

export function toAssignmentOptionAccount(
  account: { partnerAccountRef: string; displayName: string | null; handle: string | null; platform: string; primary: boolean; status: string },
  campaignPlatforms: readonly string[],
): AssignmentOptionAccount {
  const eligibility = evaluatePartnerAccountEligibility(account, campaignPlatforms);
  const platformLabel = platformDisplayLabel(eligibility.platform);
  return {
    partnerAccountRef: account.partnerAccountRef,
    label: account.displayName ?? account.handle ?? platformLabel,
    platform: eligibility.platform,
    platformLabel,
    handle: account.handle,
    primary: account.primary,
    selectable: eligibility.selectable,
    unavailableReason: eligibility.unavailableReason,
  };
}

// Deterministic order: primary first, then platform, label, ref.
export function sortAssignmentOptionAccounts(accounts: AssignmentOptionAccount[]): AssignmentOptionAccount[] {
  return [...accounts].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return a.partnerAccountRef < b.partnerAccountRef ? -1 : a.partnerAccountRef > b.partnerAccountRef ? 1 : 0;
  });
}

// ---- Service ------------------------------------------------------------

function fromPartnersFailure(result: PartnersErrorResult): ReturnType<typeof campaignsInvalidInputResult> {
  if (result.code === "unauthorized") {
    // "sensitive_denied" has no Campaigns equivalent - it can only mean a
    // more specific action denial here.
    const reason = result.reason === "not_authenticated" || result.reason === "feature_denied" || result.reason === "scope_denied" ? result.reason : "action_denied";
    return campaignsUnauthorizedResult(reason);
  }
  if (result.code === "not_found") return { ok: false, code: "not_found", message: "Partner not found." };
  if (result.code === "invalid_input") return campaignsInvalidInputResult(result.message);
  return { ok: false, code: "internal", message: "Could not load Partner options." };
}

async function resolveExistingAssignment(actor: ActorContext, campaignRef: string, partnerRef: string): Promise<AssignmentOptionsExistingAssignment | null> {
  const claim = await getAssignmentActiveClaim(campaignRef, partnerRef);
  if (!claim) return null;

  const assignment = await getAssignmentDocByUid(claim.assignmentUid);
  if (!assignment) return { assignmentRef: null, status: null, canOpen: false };

  const scope = await requireAssignmentInScope(actor, assignment);
  if (!scope.ok) return { assignmentRef: null, status: null, canOpen: false };
  return { assignmentRef: assignment.assignmentRef, status: assignment.status, canOpen: true };
}

const EMPTY_OPTIONS = { partners: [] as AssignmentOptionPartner[], hasMorePartners: false, selectedPartner: null, vendors: [] as AssignmentOptionVendor[], vendorPartners: [] as AssignmentOptionPartner[] };

export async function getAssignmentCreateOptions(
  actor: ActorContext | null,
  campaignRef: unknown,
  input: { q?: unknown; partnerRef?: unknown; vq?: unknown; vendorRef?: unknown },
): Promise<CampaignsServiceResult<AssignmentCreateOptionsDto>> {
  const campaignResult = await getCampaign(actor, campaignRef);
  if (!campaignResult.ok) return campaignResult;
  const campaign = campaignResult.data;

  const createGate = await requireAssignmentsAccess(actor, "create");
  if (!createGate.ok) return campaignsUnauthorizedResult(createGate.reason);

  if (!isCampaignStatusAllowingAssignmentCreation(campaign.status)) {
    return campaignsInvalidInputResult("Assignments can only be created while the Campaign is Planned or Active.");
  }

  if (input.partnerRef !== undefined && (typeof input.partnerRef !== "string" || input.partnerRef.length === 0 || input.partnerRef.length > MAX_REF_LENGTH)) {
    return campaignsInvalidInputResult("Invalid partnerRef.");
  }
  if (input.vendorRef !== undefined && (typeof input.vendorRef !== "string" || input.vendorRef.length === 0 || input.vendorRef.length > MAX_REF_LENGTH)) {
    return campaignsInvalidInputResult("Invalid vendorRef.");
  }
  if (input.q !== undefined && typeof input.q !== "string") return campaignsInvalidInputResult("Invalid search query.");
  if (input.vq !== undefined && typeof input.vq !== "string") return campaignsInvalidInputResult("Invalid Vendor search query.");

  const context = buildCampaignContext(campaign);

  if (typeof input.partnerRef === "string") {
    const partnerResult = await getPartner(actor, input.partnerRef);
    if (!partnerResult.ok) return fromPartnersFailure(partnerResult);
    const partner = partnerResult.data;
    if (partner.status !== "ACTIVE") return campaignsInvalidInputResult("This Partner is not active and is not eligible for a new Assignment.");

    const accountsResult = await listPartnerAccounts(actor, partner.partnerRef);
    if (!accountsResult.ok) return fromPartnersFailure(accountsResult);

    const accounts = sortAssignmentOptionAccounts(accountsResult.data.map((account) => toAssignmentOptionAccount(account, campaign.platforms)));
    const existingAssignment = await resolveExistingAssignment(actor!, campaign.campaignRef, partner.partnerRef);

    return { ok: true, data: { campaign: context, ...EMPTY_OPTIONS, selectedPartner: { ...toSafePartnerOption(partner), accounts, existingAssignment } } };
  }

  // Findings #40 (user-decided): Through-Vendor mode - `vendorRef` returns that Vendor's own ACTIVE,
  // ACTIVE-linked Partners (real relationship evidence: listVendorPartnerLinkDocsForVendor, the exact
  // same source assignment-service.ts's own bulk-create validation checks, never a free-typed Vendor
  // claim). Each linked Partner is independently re-resolved through getPartner so this stays gated on
  // the actor's own Partner Record Scope - never the (unrelated) Vendor-relationship-management
  // permission - exactly like Direct mode's own Partner picker.
  if (typeof input.vendorRef === "string") {
    const vendor = await getVendorDocByRef(input.vendorRef);
    if (!vendor) return { ok: false, code: "not_found", message: "Vendor not found." };

    const links = await listVendorPartnerLinkDocsForVendor(vendor.vendorRef);
    const activePartnerRefs = [...new Set(links.filter((link) => link.status === "ACTIVE").map((link) => link.partnerRef))];

    const vendorPartners: AssignmentOptionPartner[] = [];
    for (const partnerRef of activePartnerRefs) {
      const partnerResult = await getPartner(actor, partnerRef);
      if (!partnerResult.ok || partnerResult.data.status !== "ACTIVE") continue;
      vendorPartners.push(toSafePartnerOption(partnerResult.data));
    }
    vendorPartners.sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0));

    return { ok: true, data: { campaign: context, ...EMPTY_OPTIONS, vendorPartners } };
  }

  if (typeof input.vq === "string") {
    const vendorPrefix = input.vq.trim().toLowerCase().slice(0, MAX_SEARCH_QUERY_LENGTH);
    const vendorsResult = await listVendors(actor, { status: "ACTIVE", displayNamePrefix: vendorPrefix.length > 0 ? vendorPrefix : undefined, limit: MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS });
    if (!vendorsResult.ok) return campaignsInvalidInputResult("Could not search Vendors.");
    return {
      ok: true,
      data: { campaign: context, ...EMPTY_OPTIONS, vendors: vendorsResult.data.vendors.slice(0, MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS).map((v) => ({ vendorRef: v.vendorRef, displayName: v.displayName })) },
    };
  }

  const prefix = (input.q ?? "").toString().trim().toLowerCase().slice(0, MAX_SEARCH_QUERY_LENGTH);
  const partnersResult = await listPartners(actor, { status: "ACTIVE", displayNamePrefix: prefix.length > 0 ? prefix : undefined, limit: MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS });
  if (!partnersResult.ok) return fromPartnersFailure(partnersResult);

  return {
    ok: true,
    data: {
      campaign: context,
      ...EMPTY_OPTIONS,
      partners: partnersResult.data.partners.slice(0, MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS).map(toSafePartnerOption),
      hasMorePartners: partnersResult.data.nextCursor !== null,
    },
  };
}
