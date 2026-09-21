import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgreementHeadDto, AgreementVersionDto, AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";
import type { ConfirmedAgreementTerms } from "@/server/finance-agreements/terms";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

// The detail page's client component only needs a router for navigation after a revision is created; nothing here navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

import { AgreementDetail, type AgreementDetailProps } from "./AgreementDetail";
import type { DetailTab } from "./detail-model";

// Server-side render smoke tests (no DOM, effects do not run): which controls EXIST for which permissions, and what each tab prints.
const REF = "agr_0123456789abcdef0123";

const perms = (over: Partial<FinanceAgreementPermissionsDto>): FinanceAgreementPermissionsDto => ({
  canView: true,
  canManage: false,
  canActivate: false,
  canViewContractDetail: false,
  canViewIdentity: false,
  canManageCounterpartyKyc: false,
  counterpartyType: "PARTNER",
  byCounterpartyType: { PARTNER: { canViewIdentity: false, canManageCounterpartyKyc: false }, VENDOR: { canViewIdentity: false, canManageCounterpartyKyc: false } },
  ...over,
});
const BOTH = perms({ canManage: true, canActivate: true, canViewIdentity: true, canManageCounterpartyKyc: true });
const MANAGER = perms({ canManage: true });
const VIEWER = perms({});

const TERMS: ConfirmedAgreementTerms = {
  agreementNumber: "AG-1",
  dates: { signedDate: "2026-08-30", effectiveFrom: "2026-09-01", effectiveTo: null },
  contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null },
  platform: { platforms: ["instagram"], collaboratorPageLink: null, collaboratorPageName: null },
  commercial: {
    currency: "INR",
    paymentCycle: "MONTHLY",
    fixedComponent: { applicable: true, amountMinor: 3500000 },
    monthlyRequiredQualifyingContentCount: 4,
    qualifyingUnit: "approved_content_thread",
    accountTransferFee: null,
    advancePayment: null,
    invoiceRequired: null,
    invoiceDueTerms: null,
    paymentDueTerms: null,
    servicesMandated: null,
    incentive: null,
    lfcSfc: null,
  },
  performanceTargets: [{ targetRef: "t1", metricId: "followerGrowth", targetValue: 5000, unit: "followers", comparison: "at_least", affectsPayment: false }],
  admin: { onboardingProcessCompleted: null, remarks: null },
  agreementType: "FIXED_PLUS_REQUIRED_CONTENT",
};

const summary = (over: Partial<AgreementVersionSummaryDto> & { version: number }): AgreementVersionSummaryDto => ({
  status: "ACTIVE",
  docVersion: 4,
  sourceMode: "MANUAL",
  confirmed: true,
  confirmedAt: "2026-09-01T10:00:00.000Z",
  confirmedByUserRef: "usr_a",
  activatedAt: "2026-09-02T10:00:00.000Z",
  activatedByUserRef: "usr_b",
  supersededVersion: null,
  supersededByVersion: null,
  suspendedAt: null,
  suspendReason: null,
  endedAt: null,
  endReason: null,
  signedDate: "2026-08-30",
  effectiveFrom: "2026-09-01",
  effectiveTo: null,
  agreementType: "FIXED_PLUS_REQUIRED_CONTENT",
  createdAt: "2026-08-31T10:00:00.000Z",
  createdByUserRef: "usr_a",
  updatedAt: "2026-09-02T10:00:00.000Z",
  updatedByUserRef: "usr_b",
  ...over,
});

const doc = (sum: AgreementVersionSummaryDto, over: Partial<AgreementVersionDto> = {}): AgreementVersionDto => ({
  ...sum,
  counterparty: { type: "PARTNER", ref: "p_1", partnerAccountRefs: [], platformScope: ["instagram"] },
  source: { contractArtifactRef: null, extractionRunRef: null, parserVersion: null },
  draft: {},
  terms: sum.confirmed ? TERMS : null,
  contactSnapshot: sum.confirmed ? { counterpartyName: "Asha Rao", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: null } : null,
  identityStatus: sum.confirmed ? { state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "PRESENT" }, valuesVisible: false, capturedAt: "2026-09-01T10:00:00.000Z" } : null,
  fieldProvenance: sum.confirmed ? { currency: { origin: "MANUAL", decision: "ACCEPTED", decidedByUserRef: "usr_a", decidedAt: "2026-09-01T09:00:00.000Z", provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null } } } : null,
  ...over,
});

const head = (over: Partial<AgreementHeadDto>): AgreementHeadDto => ({
  agreementRef: REF,
  counterparty: { type: "PARTNER", ref: "p_1", partnerAccountRefs: [], platformScope: ["instagram"] },
  counterpartyDisplayName: "Asha Rao",
  status: "ACTIVE",
  latestVersion: 1,
  openVersion: null,
  activeVersion: 1,
  lastEndedVersion: null,
  docVersion: 5,
  createdAt: "2026-08-31T10:00:00.000Z",
  createdByUserRef: "usr_a",
  updatedAt: "2026-09-02T10:00:00.000Z",
  updatedByUserRef: "usr_b",
  ...over,
});

function render(over: Partial<AgreementDetailProps> & { initialHead: AgreementHeadDto; initialVersions: AgreementVersionSummaryDto[]; initialDocs: AgreementVersionDto[] }, tab: DetailTab = "overview"): string {
  const props: AgreementDetailProps = {
    initialHasMoreVersions: false,
    initialViewNumber: over.initialHead.activeVersion ?? over.initialHead.openVersion ?? 1,
    initialTab: tab,
    permissions: BOTH,
    initialReconciliation: null,
    kycStatus: { agreementRef: REF, counterpartyType: "PARTNER", state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "PRESENT" }, valuesVisible: true },
    notices: [],
    ...over,
  };
  return renderToStaticMarkup(createElement(AgreementDetail, props));
}

const V1_ACTIVE = summary({ version: 1 });
const ACTIVE = { initialHead: head({}), initialVersions: [V1_ACTIVE], initialDocs: [doc(V1_ACTIVE)] };

const V1_DRAFT = summary({ version: 1, status: "DRAFT", confirmed: false, confirmedAt: null, confirmedByUserRef: null, activatedAt: null, activatedByUserRef: null, effectiveFrom: null, signedDate: null, agreementType: null });
const FIRST_DRAFT = { initialHead: head({ status: "DRAFT", openVersion: 1, activeVersion: null }), initialVersions: [V1_DRAFT], initialDocs: [doc(V1_DRAFT)] };

const V2_DRAFT = summary({ version: 2, status: "DRAFT", confirmed: false, confirmedAt: null, confirmedByUserRef: null, activatedAt: null, activatedByUserRef: null, effectiveFrom: null, signedDate: null, agreementType: null });
const REVISION = {
  initialHead: head({ openVersion: 2, latestVersion: 2 }),
  initialVersions: [V2_DRAFT, V1_ACTIVE],
  initialDocs: [doc(V1_ACTIVE), doc(V2_DRAFT, { draft: { fixedComponent: { value: { applicable: true, amountMinor: 4000000 }, origin: "MANUAL", decision: "CORRECTED", extractedValue: null, decidedByUserRef: "usr_a", decidedAt: "2026-09-10T10:00:00.000Z", provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null } } } })],
};

describe("header and lifecycle controls exist only when the server permissions and state allow them", () => {
  it("an ACTIVE Agreement for a head / admin: Create revision, Suspend, End - and no delete", () => {
    const html = render(ACTIVE);
    expect(html).toContain("FINANCE / AGREEMENT DETAIL");
    expect(html).toContain("Back to agreements");
    expect(html).toContain(">Create revision<");
    expect(html).toContain(">Suspend Agreement<");
    expect(html).toContain(">End Agreement<");
    expect(html).not.toContain("Resume Agreement");
    expect(html).not.toContain("Continue draft");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Delete|Remove|Discard)/i);
  });

  it("a manager (no activation permission) gets none of the lifecycle buttons", () => {
    const html = render({ ...ACTIVE, permissions: MANAGER });
    for (const label of ["Create revision", "Suspend Agreement", "End Agreement", "Resume Agreement", "Activate Agreement"]) expect(html).not.toContain(`>${label}<`);
    expect(html).toContain("No lifecycle change is available for you");
  });

  it("a view-only actor gets no action button at all and an explanation", () => {
    const html = render({ ...ACTIVE, permissions: VIEWER });
    expect(html).not.toMatch(/Create revision|Suspend Agreement|End Agreement|Continue draft|Confirm Agreement/);
    expect(html).toContain("You can view this Agreement");
  });

  it("an unconfirmed first draft: Continue draft (linking the intake editor) and Confirm Agreement", () => {
    const html = render(FIRST_DRAFT);
    expect(html).toContain("Continue draft");
    expect(html).toContain(`/finance/agreements/new?agreementRef=${REF}&amp;version=1`);
    expect(html).toContain(">Confirm Agreement<");
    expect(html).not.toContain(">Activate Agreement<");
  });

  it("a confirmed draft offers Activate only (to an activator), never Confirm", () => {
    const confirmed = summary({ version: 1, status: "DRAFT", activatedAt: null, activatedByUserRef: null });
    const html = render({ initialHead: head({ status: "DRAFT", openVersion: 1, activeVersion: null }), initialVersions: [confirmed], initialDocs: [doc(confirmed)] });
    expect(html).toContain(">Activate Agreement<");
    expect(html).not.toContain(">Confirm Agreement<");
    expect(html).not.toContain("Continue draft");
  });

  it("a SUSPENDED Agreement offers Resume, not Suspend", () => {
    const suspended = summary({ version: 1, status: "SUSPENDED", suspendedAt: "2026-09-05T10:00:00.000Z", suspendReason: "Hold" });
    const html = render({ initialHead: head({ status: "SUSPENDED" }), initialVersions: [suspended], initialDocs: [doc(suspended)] });
    expect(html).toContain(">Resume Agreement<");
    expect(html).not.toContain(">Suspend Agreement<");
    expect(html).toContain(">End Agreement<");
  });
});

describe("header strip and tabs", () => {
  it("shows the eyebrow, ref, counterparty, platform scope, status text and current version; no module tab row", () => {
    const html = render(ACTIVE);
    expect(html).toContain("Agreement agr_0123456789abcdef0123");
    expect(html).toContain("Asha Rao");
    expect(html).toContain("Platforms: Instagram");
    expect(html).toContain(">Active<");
    expect(html).toContain("Current version 1 of 1");
    expect(html).toContain("1 Sep 2026");
    expect(html).not.toContain("Payables");
  });

  it("renders the six tabs as a tablist with the selected one marked", () => {
    const html = render(ACTIVE, "terms");
    expect(html).toContain('role="tablist"');
    for (const label of ["Overview", "Terms", "Verification", "KYC", "Versions", "Activity"]) expect(html).toMatch(new RegExp(`role="tab"[^>]*>${label}<`));
    expect(html).toMatch(/id="agreement-tab-terms"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="agreement-tab-overview"[^>]*aria-selected="false"/);
  });
});

describe("Terms tab", () => {
  const html = render(ACTIVE, "terms");

  it("shows confirmed terms in a payment-affecting panel and a SEPARATE warning-only targets panel", () => {
    expect(html).toContain("Payment-affecting terms");
    expect(html).toContain("₹35,000");
    expect(html).toContain("Monthly required qualifying content");
    expect(html).toContain("Approved Content");
    expect(html).toContain("Performance targets");
    expect(html).toContain("Follower growth");
    expect(html).toContain("Monitoring only · does not affect payment");
    expect(html.indexOf("Payment-affecting terms")).toBeLessThan(html.indexOf("Performance targets"));
  });

  it("never says 'Fixed deliverable units' and offers no LFC / SFC when the Agreement states none", () => {
    expect(html).not.toMatch(/deliverable/i);
    expect(html).not.toContain("LFC");
  });

  it("an unconfirmed draft has no terms to show and says why", () => {
    const draftHtml = render(FIRST_DRAFT, "terms");
    expect(draftHtml).toContain("has no confirmed terms yet");
    expect(draftHtml).not.toContain("Payment-affecting terms");
  });
});

describe("revision UX", () => {
  it("the Overview shows the changed fields of the open revision against the version in force, which stays current", () => {
    const html = render(REVISION);
    expect(html).toContain("Changes in draft version 2");
    expect(html).toContain("Compared with version 1");
    expect(html).toContain("₹35,000");
    expect(html).toContain("₹40,000");
    expect(html).toContain("Version 1 stays in force until this revision is confirmed and activated");
    expect(html).toContain("Continue draft");
    expect(html).not.toContain(">Create revision<");
    expect(html).toContain("draft version 2 open");
  });

  it("the Versions tab lists both versions, marks the roles and never offers to change a version", () => {
    const html = render(REVISION, "versions");
    expect(html).toContain("Version 2");
    expect(html).toContain("Open draft · not confirmed");
    expect(html).toContain("Current · in force");
    expect(html).toContain('aria-label="View version 2"');
    expect(html).not.toMatch(/Delete|Edit version/);
  });
});

describe("KYC and Verification tabs", () => {
  it("KYC shows status chips and never a value; the owning-record link needs the KYC permission", () => {
    const html = render(ACTIVE, "kyc");
    expect(html).toContain("PAN");
    expect(html).toContain("Available");
    expect(html).toContain("KYC available in Partner/Vendor record");
    expect(html).toContain("/partners/p_1");
    expect(html).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
    const restricted = render({ ...ACTIVE, permissions: VIEWER, kycStatus: { agreementRef: REF, counterpartyType: "PARTNER", state: "AVAILABLE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }, valuesVisible: false } }, "kyc");
    expect(restricted).toContain("Restricted");
    expect(restricted).toContain("Only the overall status is shown");
    expect(restricted).not.toContain("/partners/p_1");
  });

  it("Verification of a confirmed version shows the frozen record and states that history never changes", () => {
    const html = render(ACTIVE, "verification");
    expect(html).toContain("Frozen at confirmation");
    expect(html).toContain("never changes when Partner or Vendor master data changes later");
    expect(html).toContain("Manual entry");
  });
});

describe("Activity tab", () => {
  it("renders its own loading state on the server (events are fetched in the browser)", () => {
    const html = render(ACTIVE, "activity");
    expect(html).toContain("Activity");
    expect(html).toContain("Audit trail of this Agreement");
  });
});
