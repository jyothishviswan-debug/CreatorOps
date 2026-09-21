import type { AgreementKycComponents, AgreementKycState } from "./kyc-status-service";
import type { AgreementHeadStatus, AgreementSourceMode, AgreementType, CounterpartyType, ExtractionRunStatus } from "./types";

// Step 14B: the browser-facing shapes of the Finance Agreements WORKSPACE and the intake
// form's counterparty picker. TYPES ONLY (no zod, no runtime) so client components may import
// them freely. Every shape is an explicit allowlist of display facts:
//   - opaque refs only (agreementRef, partnerRef/vendorRef, partnerAccountRef) - never a
//     Firebase uid, and never a scope-snapshot field (owner / region / team / uid);
//   - no restricted identity VALUE (PAN / Aadhaar / GSTIN / bank / IFSC / holder name), no
//     address / PIN (there is no canonical field for them), no contract locator or snippet;
//   - KYC appears ONLY as status; per-component detail is the literal "RESTRICTED" unless the
//     actor holds the counterparty's identity sensitive category.
// Rows are a LIST PROJECTION ("as of last update") - never authorization or lifecycle truth.

// --- Query (parsed URL / API state) --------------------------------------------------------------------------------------------
// URL / API param names (all optional): lifecycle, counterpartyType, q, platform, period, discrepancy, cursor, limit.
export type AgreementWorkspaceLifecycleFilter = AgreementHeadStatus; // DRAFT | ACTIVE | SUSPENDED | ENDED
// "current" = the governing version's effective range covers today; "YYYY-MM" = the range overlaps that calendar month.
export type AgreementWorkspacePeriodFilter = "current" | (string & {});
// "open" = only Agreements with at least one unresolved (PENDING / undecided) draft field.
export type AgreementWorkspaceDiscrepancyFilter = "open";

export type AgreementWorkspaceQuery = {
  lifecycle: AgreementWorkspaceLifecycleFilter | null;
  counterpartyType: CounterpartyType | null;
  // Counterparty name search: case-insensitive substring over the stored display snapshot, 1-80 chars after trim.
  q: string | null;
  // Normalized platform id (lower-case, e.g. "instagram", "youtube"); matches the Partner platform scope.
  platform: string | null;
  period: AgreementWorkspacePeriodFilter | null;
  discrepancy: AgreementWorkspaceDiscrepancyFilter | null;
  // Opaque; produced by a previous response's nextCursor and never to be interpreted by the client.
  cursor: string | null;
  // 1-20, default 20.
  limit: number;
};

// --- Rows ----------------------------------------------------------------------------------------------------------------------
// What the primary row button should offer (a HINT; the destination page re-checks everything server-side).
//   CONTINUE_DRAFT   the open version is an unconfirmed DRAFT (a first draft or a revision in progress)
//   REVIEW           the open version is confirmed and awaiting activation
//   CREATE_REVISION  ACTIVE Agreement with no open version, and the actor may activate/revise
//   OPEN             everything else (read-only entry)
export type AgreementWorkspacePrimaryActionKind = "CONTINUE_DRAFT" | "REVIEW" | "CREATE_REVISION" | "OPEN";
export type AgreementWorkspacePrimaryActionDto = { kind: AgreementWorkspacePrimaryActionKind; version: number | null };

export type AgreementWorkspaceKycDto = {
  state: AgreementKycState;
  // RESTRICTED per component unless the actor holds the identity category for this counterparty type.
  components: AgreementKycComponents;
};

export type AgreementWorkspaceRowDto = {
  agreementRef: string;
  counterparty: {
    type: CounterpartyType;
    ref: string;
    // LIVE counterparty display name (the stored snapshot is used only for search/filter).
    displayName: string;
    platformScope: string[];
  };
  // The governing version (active / suspended, else the ended one, else the open draft, else the latest).
  currentVersion: number;
  openVersion: number | null;
  lifecycle: AgreementHeadStatus;
  agreementNumber: string | null;
  agreementType: AgreementType | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceMode: AgreementSourceMode | null;
  kyc: AgreementWorkspaceKycDto;
  extractionStatus: ExtractionRunStatus | null;
  unresolvedFieldCount: number;
  // unresolvedFieldCount > 0 (a discrepancy / undecided field exists).
  hasDiscrepancy: boolean;
  lastUpdatedAt: string;
  primaryAction: AgreementWorkspacePrimaryActionDto;
};

// --- Permissions ---------------------------------------------------------------------------------------------------------------
// Booleans computed from REAL grants (feature / action / sensitive category) - never from a role name.
export type FinanceAgreementPermissionsDto = {
  // finance feature view (list / read Agreements).
  canView: boolean;
  // manage_agreements: create draft, decide fields, extract, confirm, master-data commands.
  canManage: boolean;
  // activate_agreements: activate, revise, suspend, resume, end.
  canActivate: boolean;
  // finance_contracts sensitive category: raw contract snippets/locators.
  canViewContractDetail: boolean;
  // The identity category of the requested counterparty type (payment_details / vendor_payment_details);
  // false when no counterpartyType was requested (see byCounterpartyType).
  canViewIdentity: boolean;
  // The owning module's manage_*_restricted_identity action AND the identity category, for the requested type.
  canManageCounterpartyKyc: boolean;
  // Step 14B.1 (agreement-led onboarding): the OWNING modules' own grants, each combined with the finance feature view (like every boolean
  // here). Creating a counterparty from an Agreement needs canManage AND the matching create right AND (Partner accounts) canManagePartnerAccounts;
  // the server re-checks all of them - these only decide which onboarding choices are offered.
  //   canCreatePartner          the partners feature + partners:create
  //   canCreateVendor           the vendors feature + vendors:create
  //   canManagePartnerAccounts  the partners feature + partners:manage_partner_accounts
  canCreatePartner: boolean;
  canCreateVendor: boolean;
  canManagePartnerAccounts: boolean;
  counterpartyType: CounterpartyType | null;
  byCounterpartyType: Record<CounterpartyType, { canViewIdentity: boolean; canManageCounterpartyKyc: boolean }>;
};

// --- Workspace ------------------------------------------------------------------------------------------------------------------
export type AgreementWorkspaceDisclosureDto = {
  // Heads read by the bounded scope-first scan (before live re-verification / filters).
  headsRead: number;
  // true = more Agreements exist in scope than the scan ceiling; totalInBoundedSet is then a LOWER BOUND.
  headsTruncated: boolean;
  scanLimit: number;
};

export type AgreementWorkspaceDto = {
  rows: AgreementWorkspaceRowDto[];
  nextCursor: string | null;
  // Zero-based offset of the first row of this page and the page size used (for numbered pagers).
  offset: number;
  pageSize: number;
  // The exact size of the bounded, filtered result (the cursor pages over it). NOT the total in scope when
  // disclosure.headsTruncated - never present it as an exact total then.
  totalInBoundedSet: number;
  disclosure: AgreementWorkspaceDisclosureDto;
  // Human-readable neutral notices (e.g. an invalid filter value that was ignored, truncation).
  notices: string[];
  permissions: FinanceAgreementPermissionsDto;
};

// --- Counterparty picker / preview (intake form) ----------------------------------------------------------------------------
export type CounterpartySearchResultDto = {
  type: CounterpartyType;
  ref: string;
  displayName: string;
  regions: string[];
  status: string;
};

export type CounterpartyPartnerAccountDto = {
  partnerAccountRef: string;
  // Normalized platform id (e.g. "instagram", "youtube").
  platform: string;
  handle: string | null;
  displayName: string | null;
  profileUrl: string | null;
  status: "ACTIVE" | "INACTIVE";
  primary: boolean;
};

// The fields CreatorOps has no canonical home for (never invented, never prefilled).
export type CounterpartyUnavailableFieldDto = { fieldKey: "address" | "pinCode"; reason: "no_canonical_field" };

export type CounterpartyPreviewDto = {
  source: "CreatorOps master data";
  type: CounterpartyType;
  ref: string;
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  regions: string[];
  status: string;
  // PARTNER only (empty for a Vendor): the canonical Partner Accounts of THAT Partner.
  partnerAccounts: CounterpartyPartnerAccountDto[];
  // KYC STATUS only. `state` is always visible to an authorized actor; components (and gstin) are RESTRICTED
  // without the counterparty's identity sensitive category.
  kyc: { state: AgreementKycState; components: AgreementKycComponents; valuesVisible: boolean };
  // The canonical GSTIN as STATUS only (never the number). Named `gstinStatus` (not `gstin`) on purpose: the boundary guards
  // forbid any property called gstin outside the field registry. RESTRICTED without the counterparty's identity category.
  gstinStatus: "PRESENT" | "MISSING" | "INCOMPLETE" | "NOT_APPLICABLE" | "RESTRICTED";
  unavailableFields: CounterpartyUnavailableFieldDto[];
};
