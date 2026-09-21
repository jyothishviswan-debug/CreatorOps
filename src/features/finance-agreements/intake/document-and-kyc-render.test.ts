import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

// The provider only needs a router for navigation after "Start draft"; nothing here navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

import { agreementDto, permissionsDto } from "./intake-fixtures";
import { IntakeProvider, type IntakeProviderProps } from "./intake-context";
import { KycSection } from "./KycSection";
import { ReviewConfirmSection } from "./ReviewConfirmSection";

// Server-side render (effects do not run): which controls EXIST for which server-computed permission and state.
type DocumentDto = NonNullable<Parameters<typeof agreementDto>[0]>["document"];

const LINK = "https://drive.invalid/fake/file_1";
const PENDING: DocumentDto = { status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: true };
const STORED: DocumentDto = { status: "STORED", fileName: "Asha Rao Agreement.pdf", storedAt: "2026-09-03T09:30:00.000Z", hasLink: true, link: LINK, attemptCount: 1, message: null, canStore: false };
const STORED_NO_LINK: DocumentDto = { ...STORED, link: undefined };
const FAILED: DocumentDto = { status: "FAILED", fileName: "Asha Rao Agreement.pdf", storedAt: null, hasLink: false, attemptCount: 1, message: "Drive is temporarily unavailable. Try again.", canStore: true };
const NOT_CONFIGURED: DocumentDto = { status: "NOT_CONFIGURED", fileName: "Asha Rao Agreement.pdf", storedAt: null, hasLink: false, attemptCount: 1, message: "Drive storage not configured", canStore: true };
const NOT_APPLICABLE: DocumentDto = { status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false };

// The opening tag of the button with this data-testid (or null): `disabled=""` is the real attribute; aria-disabled alone is not the state.
function buttonTag(html: string, testId: string): string | null {
  return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? null;
}
const isDisabled = (html: string, testId: string): boolean => /\sdisabled=""/.test(buttonTag(html, testId) ?? "");

const ACTIVATOR = permissionsDto({ canManage: true, canActivate: true });
const MANAGER = permissionsDto({ canManage: true, canActivate: false });

// `children` is passed as the third createElement argument; the props object only satisfies the (required) prop type.
const providerProps = (permissions: FinanceAgreementPermissionsDto, initial: IntakeProviderProps["initial"]): IntakeProviderProps => ({ permissions, initial, children: null });

function renderReview(over: { document?: DocumentDto; confirmed?: boolean; permissions?: FinanceAgreementPermissionsDto } = {}): string {
  const agreement = agreementDto({ confirmed: over.confirmed ?? true, document: over.document ?? PENDING });
  return renderToStaticMarkup(createElement(IntakeProvider, providerProps(over.permissions ?? ACTIVATOR, { agreement }), createElement(ReviewConfirmSection)));
}

describe("Review & confirm: the Agreement document after Confirm", () => {
  it("nothing about the document before the version is confirmed", () => {
    const html = renderReview({ confirmed: false });
    expect(html).not.toContain('data-testid="review-document"');
    expect(html).not.toContain("Store Agreement document");
    expect(buttonTag(html, "activate-agreement")).toBeNull();
  });

  it("confirmed and not stored yet: a visible status, a Store button for a manager, and Activate DISABLED with the plain reason", () => {
    const html = renderReview({ document: PENDING });
    expect(html).toContain('data-testid="review-document"');
    expect(html).toContain('data-document-phase="pending"');
    expect(html).toContain("The original signed Agreement is not stored yet.");
    expect(html).toContain('data-testid="store-agreement-document"');
    expect(html).toContain("Store Agreement document");
    expect(isDisabled(html, "activate-agreement")).toBe(true);
    expect(html).toContain("Store the signed Agreement document before activating this version.");
    expect(html).toMatch(/aria-live="polite"/);
  });

  it("a failed store keeps the plain reason visible, offers Retry, and keeps Activate disabled", () => {
    const html = renderReview({ document: FAILED });
    expect(html).toContain('data-document-phase="failed"');
    expect(html).toContain("The original signed Agreement could not be stored.");
    expect(html).toContain("Drive is temporarily unavailable. Try again.");
    expect(html).toContain(">Retry<");
    expect(isDisabled(html, "activate-agreement")).toBe(true);
    expect(html).toContain("Retry storing it before activating");
  });

  it("Drive storage not configured is said plainly and blocks Activate", () => {
    const html = renderReview({ document: NOT_CONFIGURED });
    expect(html).toContain("Drive storage not configured");
    expect(isDisabled(html, "activate-agreement")).toBe(true);
    expect(html).toContain("before activating");
  });

  it("stored: 'Stored' is visible, Activate is an ordinary enabled button, no reason text, and the link shows only when the server sent it", () => {
    const html = renderReview({ document: STORED });
    expect(html).toContain('data-document-phase="stored"');
    expect(html).toContain("Stored. The original signed Agreement is in Drive.");
    expect(buttonTag(html, "activate-agreement")).not.toBeNull();
    expect(isDisabled(html, "activate-agreement")).toBe(false);
    expect(html).not.toContain('data-testid="activate-blocked-reason"');
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    const neutral = renderReview({ document: STORED_NO_LINK });
    expect(neutral).toContain("Agreement document on file");
    expect(neutral).not.toContain("Open Agreement document");
  });

  it("a version with no signed file of its own is not blocked and is labelled honestly (never the prior file)", () => {
    const html = renderReview({ document: NOT_APPLICABLE });
    expect(html).toContain('data-document-phase="not_applicable"');
    expect(html).toContain("No new signed document for this version");
    expect(buttonTag(html, "activate-agreement")).not.toBeNull();
    expect(isDisabled(html, "activate-agreement")).toBe(false);
    expect(html).not.toContain("Store Agreement document");
  });

  it("someone who cannot activate has no Activate button at all (nothing revealed then hidden); their Store button still follows the server", () => {
    const html = renderReview({ document: PENDING, permissions: MANAGER });
    expect(buttonTag(html, "activate-agreement")).toBeNull();
    expect(html).not.toContain('data-testid="activate-blocked-reason"');
    expect(html).toContain("Store Agreement document");
  });
});

const kycStatus = (state: AgreementKycStatusDto["state"], components: AgreementKycStatusDto["components"]): AgreementKycStatusDto => ({ agreementRef: "agr_0123456789abcdef0123", counterpartyType: "PARTNER", state, components, valuesVisible: false });

function renderKyc(kyc: AgreementKycStatusDto, access: { canViewIdentity: boolean; canManageCounterpartyKyc: boolean }): string {
  const permissions = permissionsDto({ canManage: true, counterpartyType: "PARTNER", ...access, byCounterpartyType: { PARTNER: { ...access }, VENDOR: { canViewIdentity: false, canManageCounterpartyKyc: false } } });
  return renderToStaticMarkup(createElement(IntakeProvider, providerProps(permissions, { agreement: agreementDto({}), kyc }), createElement(KycSection)));
}
const AUTHORIZED = { canViewIdentity: true, canManageCounterpartyKyc: true };
const ALL_PRESENT = { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" } as const;

describe("KYC section: per-component actions", () => {
  it("everything present: no KYC upload action anywhere and the text 'KYC available in Partner/Vendor record'", () => {
    const html = renderKyc(kycStatus("AVAILABLE", ALL_PRESENT), AUTHORIZED);
    expect(html).toContain("KYC available in Partner/Vendor record");
    expect(html).not.toContain("Upload / Update");
    expect(html).not.toContain("Complete bank details");
    expect(html.match(/data-kind="available"/g)?.length).toBe(4);
  });

  it("only PAN missing: only the PAN row has an action", () => {
    const html = renderKyc(kycStatus("MISSING", { ...ALL_PRESENT, pan: "MISSING" }), AUTHORIZED);
    expect(html.match(/aria-label="Upload \/ Update KYC for [^"]*"/g)).toEqual(['aria-label="Upload / Update KYC for PAN"']);
    expect(html).toContain("PAN needs attention.");
    expect(html).not.toContain("Complete bank details");
  });

  it("incomplete bank: only the Bank row has an action, reading 'Complete bank details'", () => {
    const html = renderKyc(kycStatus("INCOMPLETE", { ...ALL_PRESENT, bank: "INCOMPLETE" }), AUTHORIZED);
    expect(html.match(/aria-label="[^"]*Upload \/ Update KYC for [^"]*"/g)?.length).toBe(1);
    expect(html).toContain("Upload / Update KYC for Bank details");
    expect(html).toContain(">Complete bank details<");
    expect(html).toContain("Incomplete");
  });

  it("without the owning KYC action (or without the identity category) the rows are status only, whoever they are", () => {
    for (const access of [
      { canViewIdentity: true, canManageCounterpartyKyc: false },
      { canViewIdentity: false, canManageCounterpartyKyc: true },
    ]) {
      const html = renderKyc(kycStatus("MISSING", { ...ALL_PRESENT, pan: "MISSING", bank: "INCOMPLETE" }), access);
      expect(html).not.toContain("Upload / Update");
      expect(html).not.toContain("Complete bank details");
    }
  });

  it("no sensitive access: every component is Restricted, only the overall status shows and there is no upload or reveal action", () => {
    const html = renderKyc(kycStatus("INCOMPLETE", { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }), { canViewIdentity: false, canManageCounterpartyKyc: false });
    expect(html).toContain("You can see the overall KYC status only");
    expect(html.match(/data-kind="restricted"/g)?.length).toBe(4);
    expect(html).not.toContain("Upload / Update");
    expect(html).not.toMatch(/Reveal/i);
  });
});
