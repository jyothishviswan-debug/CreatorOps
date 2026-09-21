import { z } from "zod";

import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { listPartnerAccountDocs, listPartnerDocs } from "@/server/partners/firestore";
import { normalizePlatformIdentifier } from "@/server/shared/platform";
import { listVendorDocs } from "@/server/vendors/firestore";
import type { VendorDoc } from "@/server/vendors/types";
import type { PartnerDoc } from "@/server/partners/types";
import type { CompoundListCursor } from "@/server/shared/scoped-list";

import { loadAuthorizedCounterparty, requireFinanceAgreementsAccess, requireIdentitySensitiveAccess } from "./finance-agreements-gate";
import { computeIdentityStatus } from "./identity-status";
import type { AgreementKycComponents } from "./kyc-status-service";
import { formatIssues } from "./service-common";
import {
  counterpartyTypeSchema,
  financeAgreementsInvalidInputResult,
  financeAgreementsUnauthorizedResult,
  type FinanceAgreementsServiceResult,
} from "./types";
import type { CounterpartyPartnerAccountDto, CounterpartyPreviewDto, CounterpartySearchResultDto } from "./workspace-dto";

// Step 14B: the intake form's authorized counterparty PICKER - a search and a preview. Both need the `finance` feature AND
// `manage_agreements` (only someone who can start an Agreement may look for a counterparty to start one for) and neither needs
// the `partners` / `vendors` feature: Finance reaches the master data through the owning modules' own scope machinery.
//
//   search   scope-FIRST (the owning modules' scoped list plans decide what is reachable BEFORE any document is read), ACTIVE
//            counterparties only, display identity only {type, ref, displayName, regions, status}
//   preview  the live Record Scope of the named Partner / Vendor (a missing, out-of-scope or forged ref is the neutral
//            not_found), and ONLY ordinary master data plus STATUS: name / legal name, email, phone, regions, the Partner's own
//            Partner Accounts, KYC status (state visible; per-component only with the identity category, else RESTRICTED) and
//            the canonical GSTIN as status. No PAN / Aadhaar / GSTIN / bank / IFSC / holder name, no evidence link, no owner or
//            scope internals. Address and PIN have NO canonical field - reported as explicitly unavailable, never invented.

export const COUNTERPARTY_SEARCH_MAX_LIMIT = 10;
export const COUNTERPARTY_SEARCH_MAX_QUERY = 80;

const searchInputSchema = z
  .object({
    type: counterpartyTypeSchema,
    q: z.string().trim().max(COUNTERPARTY_SEARCH_MAX_QUERY).optional(),
    limit: z.number().int().min(1).max(COUNTERPARTY_SEARCH_MAX_LIMIT).optional(),
  })
  .strict();

export type CounterpartySearchResponse = { results: CounterpartySearchResultDto[]; hasMore: boolean };

export async function searchCounterparties(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<CounterpartySearchResponse>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = searchInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  const grants = await getActorScopeGrants(actor!);
  const scope = { actorUid: actor!.uid, grants, hasGlobal: hasGlobalScope(grants) };
  const limit = parsed.data.limit ?? COUNTERPARTY_SEARCH_MAX_LIMIT;
  const prefix = parsed.data.q && parsed.data.q.length > 0 ? parsed.data.q.toLowerCase() : undefined;

  if (parsed.data.type === "PARTNER") {
    const found = await collectActive<PartnerDoc, CompoundListCursor>(limit, (cursor) => listPartnerDocs({ limit: SEARCH_SCAN_PAGE, ...scope, displayNamePrefix: prefix, cursor }).then((page) => ({ items: page.partners, nextCursor: page.nextCursor })));
    return {
      ok: true,
      data: { results: found.items.map((partner) => ({ type: "PARTNER", ref: partner.partnerRef, displayName: partner.displayName, regions: [...partner.regionIds], status: partner.status })), hasMore: found.hasMore },
    };
  }
  const found = await collectActive<VendorDoc, CompoundListCursor>(limit, (cursor) => listVendorDocs({ limit: SEARCH_SCAN_PAGE, ...scope, displayNamePrefix: prefix, cursor }).then((page) => ({ items: page.vendors, nextCursor: page.nextCursor })));
  return {
    ok: true,
    data: { results: found.items.map((vendor) => ({ type: "VENDOR", ref: vendor.vendorRef, displayName: vendor.displayName, regions: [...vendor.regionIds], status: vendor.status })), hasMore: found.hasMore },
  };
}

// ACTIVE-only WITHOUT pushing `status` into the scoped Firestore query: a scope x status x displayNameLower composite is not one of
// the certified index shapes (scope x createdAt, scope x displayNameLower and status x scope x createdAt are). The scope-first list
// is read in bounded pages and ACTIVE is applied in memory; the scan is capped, and when the cap (or a further ACTIVE match) is
// reached `hasMore` is true so the caller narrows the query instead of trusting a silently short list.
const SEARCH_SCAN_PAGE = 50;
const SEARCH_SCAN_MAX_PAGES = 4;

async function collectActive<T extends { status: string }, C>(limit: number, fetchPage: (cursor: C | undefined) => Promise<{ items: T[]; nextCursor: C | null }>): Promise<{ items: T[]; hasMore: boolean }> {
  const items: T[] = [];
  let cursor: C | undefined;
  for (let pageNumber = 0; pageNumber < SEARCH_SCAN_MAX_PAGES; pageNumber += 1) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      if (item.status !== "ACTIVE") continue;
      if (items.length >= limit) return { items, hasMore: true };
      items.push(item);
    }
    if (!page.nextCursor) return { items, hasMore: false };
    cursor = page.nextCursor;
  }
  return { items, hasMore: true };
}

const previewInputSchema = z.object({ type: counterpartyTypeSchema, ref: z.string().trim().min(1).max(200) }).strict();

const RESTRICTED_COMPONENTS: AgreementKycComponents = { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" };

export async function getCounterpartyPreview(actor: ActorContext | null, rawInput: unknown): Promise<FinanceAgreementsServiceResult<CounterpartyPreviewDto>> {
  const access = await requireFinanceAgreementsAccess(actor, "manage_agreements");
  if (!access.ok) return financeAgreementsUnauthorizedResult(access.reason);

  const parsed = previewInputSchema.safeParse(rawInput);
  if (!parsed.success) return financeAgreementsInvalidInputResult(formatIssues(parsed.error));

  // Live Record Scope of the named counterparty (never client-supplied scope). No partnerAccountRefs are named here.
  const loaded = await loadAuthorizedCounterparty(actor!, parsed.data.type === "PARTNER" ? { type: "PARTNER", partnerRef: parsed.data.ref } : { type: "VENDOR", vendorRef: parsed.data.ref });
  if (!loaded.ok) return loaded.error;
  const authorized = loaded.authorized;

  const subjectUid = authorized.type === "PARTNER" ? authorized.scope.partnerUid : authorized.scope.vendorUid;
  const [identityCategory, status] = await Promise.all([requireIdentitySensitiveAccess(actor!, authorized.type), computeIdentityStatus(authorized.type, subjectUid ?? "")]);
  const valuesVisible = identityCategory.ok;

  let partnerAccounts: CounterpartyPartnerAccountDto[] = [];
  if (authorized.type === "PARTNER") {
    // Only THIS Partner's own accounts (bounded, ordered by creation).
    const accounts = await listPartnerAccountDocs(authorized.partner.partnerRef);
    partnerAccounts = accounts
      .filter((account) => account.partnerRef === authorized.partner.partnerRef)
      .map((account) => ({
        partnerAccountRef: account.partnerAccountRef,
        platform: normalizePlatformIdentifier(account.platform),
        handle: account.handle,
        displayName: account.displayName,
        profileUrl: account.profileUrl,
        status: account.status,
        primary: account.primary,
      }));
  }

  const master = authorized.type === "PARTNER" ? authorized.partner : authorized.vendor;
  return {
    ok: true,
    data: {
      source: "CreatorOps master data",
      type: authorized.type,
      ref: authorized.type === "PARTNER" ? authorized.partner.partnerRef : authorized.vendor.vendorRef,
      displayName: master.displayName,
      legalName: master.legalName,
      email: master.email,
      phone: master.phone,
      regions: [...master.regionIds],
      status: master.status,
      partnerAccounts,
      kyc: { state: status.state, components: valuesVisible ? { ...status.components } : { ...RESTRICTED_COMPONENTS }, valuesVisible },
      gstinStatus: valuesVisible ? status.components.gst : "RESTRICTED",
      unavailableFields: [
        { fieldKey: "address", reason: "no_canonical_field" },
        { fieldKey: "pinCode", reason: "no_canonical_field" },
      ],
    },
  };
}
