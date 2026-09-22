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
  canCreatePartner: false,
  canCreateVendor: false,
  canManagePartnerAccounts: false,
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
    contentObligations: [],
    monetisationTerms: null,
  },
  performanceTargets: [{ targetRef: "t1", metricId: "followerGrowth", targetValue: 5000, unit: "followers", comparison: "at_least", period: null, anchor: null, affectsPayment: false }],
  performanceEvaluationClause: null,
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
  document: { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false },
  ...over,
});

const doc = (sum: AgreementVersionSummaryDto, over: Partial<AgreementVersionDto> = {}): AgreementVersionDto => ({
  ...sum,
  counterparty: { type: "PARTNER", ref: "p_1", partnerAccountRefs: [], platformScope: ["instagram"] },
  parties: [],
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
  priorAgreementRef: null,
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

// Step 14B.1: the Agreement document panel (Overview) and the Versions tab Document column. Rendered on the server (no effects): the buttons that EXIST
// for which permissions and which document state, and the honest copy for each state.
describe("Agreement document panel (Overview)", () => {
  const LINK = "https://drive.invalid/fake/file_1";
  type DocumentDto = AgreementVersionSummaryDto["document"];
  const STORED: DocumentDto = { status: "STORED", fileName: "Asha Rao Agreement (signed).pdf", storedAt: "2026-09-03T09:30:00.000Z", hasLink: true, link: LINK, attemptCount: 1, message: null, canStore: false };
  const STORED_NO_LINK: DocumentDto = { ...STORED, link: undefined };
  const PENDING: DocumentDto = { status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: true };
  const FAILED: DocumentDto = { status: "FAILED", fileName: "Asha Rao Agreement (signed).pdf", storedAt: null, hasLink: false, attemptCount: 2, message: "Drive is temporarily unavailable. Try again.", canStore: true };
  const NOT_CONFIGURED: DocumentDto = { status: "NOT_CONFIGURED", fileName: "Asha Rao Agreement (signed).pdf", storedAt: null, hasLink: false, attemptCount: 1, message: "Drive storage not configured", canStore: true };

  const activeWith = (document: DocumentDto, permissions: FinanceAgreementPermissionsDto = BOTH) => {
    const version = summary({ version: 1, document });
    return { initialHead: head({}), initialVersions: [version], initialDocs: [doc(version)], permissions };
  };
  // A confirmed draft waiting for activation (nothing governs yet).
  const confirmedWith = (document: DocumentDto, permissions: FinanceAgreementPermissionsDto = BOTH) => {
    const version = summary({ version: 1, status: "DRAFT", activatedAt: null, activatedByUserRef: null, document });
    return { initialHead: head({ status: "DRAFT", openVersion: 1, activeVersion: null }), initialVersions: [version], initialDocs: [doc(version)], permissions };
  };

  it("STORED for a contract-detail holder: file name, stored date, `Open Agreement document` in a new tab with noopener - and no store button", () => {
    const html = render(activeWith(STORED));
    expect(html).toContain("Agreement document");
    expect(html).toContain("Asha Rao Agreement (signed).pdf");
    expect(html).toContain("The original signed Agreement is stored in Drive.");
    expect(html).toMatch(new RegExp(`<a[^>]*href="${LINK}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|<a[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*href="${LINK}"`));
    expect(html).toContain("Open Agreement document");
    expect(html).not.toContain("Store Agreement document");
    expect(html).not.toContain(">Retry<");
  });

  it("STORED for someone without the contract-detail category: 'Agreement document on file' and NO link at all", () => {
    const html = render(activeWith(STORED_NO_LINK, MANAGER));
    expect(html).toContain("Agreement document on file");
    expect(html).not.toContain("Open Agreement document");
    expect(html).not.toContain("drive.invalid");
  });

  it("PENDING and confirmed: a `Store Agreement document` button for a manager, none for a view-only actor", () => {
    expect(render(confirmedWith(PENDING))).toContain("Store Agreement document");
    expect(render(confirmedWith(PENDING, MANAGER))).toContain("Store Agreement document");
    const viewer = render(confirmedWith(PENDING, VIEWER));
    expect(viewer).toContain("The original signed Agreement is not stored yet.");
    expect(viewer).not.toContain("Store Agreement document");
  });

  it("FAILED: the plain reason, nothing claimed as stored, and a Retry", () => {
    const html = render(activeWith(FAILED));
    expect(html).toContain("The original signed Agreement could not be stored.");
    expect(html).toContain("Drive is temporarily unavailable. Try again.");
    expect(html).toContain("Nothing was recorded as stored");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("Open Agreement document");
    expect(html).not.toContain("is stored in Drive");
  });

  it("NOT_CONFIGURED: the honest 'Drive storage not configured', a Retry, and never a link", () => {
    const html = render(activeWith(NOT_CONFIGURED));
    expect(html).toContain("Drive storage not configured");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("Open Agreement document");
  });

  it("NOT_APPLICABLE: 'No new signed document for this version' - never a file, a link or an action", () => {
    const html = render(ACTIVE);
    expect(html).toContain("No new signed document for this version");
    expect(html).not.toContain("Open Agreement document");
    expect(html).not.toContain("Store Agreement document");
  });

  it("the store button is disabled with the busy style semantics wired to aria-disabled and an accessible name naming the version", () => {
    const html = render(confirmedWith(PENDING));
    expect(html).toContain('aria-label="Store Agreement document, version 1"');
    expect(html).toContain('data-testid="document-store-1"');
    // announced politely
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
  });

  // The lifecycle action bar only (the confirmation dialog renders its own footer buttons, which would otherwise match).
  const lifecyclePanel = (html: string) => {
    const start = html.indexOf('aria-label="Lifecycle actions"');
    return html.slice(start, html.indexOf("</section>", start));
  };

  it("Activate stays present for an activator but is DISABLED with the plain reason until the document is stored", () => {
    const blocked = lifecyclePanel(render(confirmedWith(PENDING)));
    expect(blocked).toMatch(/<button(?=[^>]*aria-describedby="activate-blocked-reason")(?=[^>]*\sdisabled="")[^>]*>Activate Agreement</);
    expect(blocked).toContain("Store the signed Agreement document before activating this version.");
    expect(lifecyclePanel(render(confirmedWith(FAILED)))).toContain("Retry storing it before activating");
    const notConfigured = lifecyclePanel(render(confirmedWith(NOT_CONFIGURED)));
    expect(notConfigured).toContain("Drive storage not configured");
    expect(notConfigured).toMatch(/<button[^>]*\sdisabled=""[^>]*>Activate Agreement</);
    // stored (or no document of its own): Activate is an ordinary enabled button with no reason
    for (const ok of [STORED, STORED_NO_LINK]) {
      const panel = lifecyclePanel(render(confirmedWith(ok)));
      expect(panel).toMatch(/<button[^>]*>Activate Agreement</);
      expect(panel).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Activate Agreement</);
      expect(panel).not.toContain("activate-blocked-reason");
    }
    expect(lifecyclePanel(render(ACTIVE))).not.toContain("Activate Agreement");
  });

  it("a confirmed replacement waiting for activation gets its OWN row (with its store button) while the version in force is viewed", () => {
    const v1 = summary({ version: 1, document: STORED });
    const v2 = summary({ version: 2, status: "DRAFT", activatedAt: null, activatedByUserRef: null, document: PENDING });
    const html = render({ initialHead: head({ openVersion: 2, latestVersion: 2 }), initialVersions: [v2, v1], initialDocs: [doc(v1), doc(v2)] });
    expect(html).toContain("Version 2 · Waiting for activation");
    expect(html).toContain("Version 1 · Current version");
    expect(html.indexOf("Version 2 · Waiting for activation")).toBeLessThan(html.indexOf("Version 1 · Current version"));
    expect(html).toContain('aria-label="Store Agreement document, version 2"');
    // v1's own link is v1's; v2 shows none
    expect(html.split("Open Agreement document").length - 1).toBe(1);
  });

  it("the Versions tab has a Document column: each version's own status, and the link only when the server sent it", () => {
    const v1 = summary({ version: 1, status: "SUPERSEDED", supersededByVersion: 2, document: { ...STORED, fileName: "v1.pdf", link: "https://drive.invalid/fake/v1" } });
    const v2 = summary({ version: 2, supersededVersion: 1, document: { ...STORED, fileName: "v2.pdf", link: "https://drive.invalid/fake/v2" } });
    const html = render({ initialHead: head({ activeVersion: 2, latestVersion: 2 }), initialVersions: [v2, v1], initialDocs: [doc(v2)], initialViewNumber: 2 }, "versions");
    expect(html).toContain('<th scope="col">Document</th>');
    expect(html).toContain('data-testid="version-document-1"');
    expect(html).toContain("v1.pdf");
    expect(html).toContain("v2.pdf");
    expect(html).toContain('href="https://drive.invalid/fake/v1"');
    expect(html).toContain('href="https://drive.invalid/fake/v2"');
    const noLink = render({ initialHead: head({}), initialVersions: [summary({ version: 1, document: STORED_NO_LINK })], initialDocs: [doc(summary({ version: 1, document: STORED_NO_LINK }))], permissions: MANAGER }, "versions");
    expect(noLink).toContain("Agreement document on file");
    expect(noLink).not.toContain("drive.invalid");
    expect(render(ACTIVE, "versions")).toContain("No new signed document for this version");
  });
});
