import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

import { IntakeForm } from "../IntakeForm";
import { IntakeProvider, type IntakeProviderProps } from "../intake-context";
import { agreementDto, permissionsDto } from "../intake-fixtures";

// The REAL provider + form, server-rendered (effects do not run): section 1's mode choice, when the wizard replaces sections 2-5, and what the
// right-hand checklist follows.
const CAN_CREATE = permissionsDto({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });

function render(permissions: FinanceAgreementPermissionsDto, initial?: IntakeProviderProps["initial"]): string {
  return renderToStaticMarkup(createElement(IntakeProvider, { permissions, initial } as IntakeProviderProps, createElement(IntakeForm)));
}

describe("the new-Agreement form without an onboarding choice (unchanged)", () => {
  const markup = render(CAN_CREATE);
  it("is the current flow: the four cards, Start draft, the existing-details section, and no wizard", () => {
    expect(markup).toContain("Instagram Partner");
    expect(markup).toContain("Instagram + YouTube Partner");
    expect(markup).toContain('data-testid="start-draft"');
    expect(markup).toContain("Existing CreatorOps details");
    expect(markup).not.toContain("onboarding-upload");
    expect(markup).not.toContain("Create new");
    expect(markup).toContain("Contract source, Cross-verification, Commercial terms, Performance targets, KYC and Review open once the draft is started.");
  });
  it("keeps the ten-step checklist", () => {
    expect(markup).toContain("1. Agreement for");
    expect(markup).toContain("10. Review &amp; confirm");
    expect(markup).not.toContain("Signed Agreement");
  });
});

describe("create-new deep link for a Vendor", () => {
  const markup = render(CAN_CREATE, { onboarding: { mode: "new", counterpartyType: "VENDOR" } });

  it("offers both modes, with Create new selected, and opens the wizard in place of the counterparty search", () => {
    expect(markup).toContain("Select existing Vendor");
    expect(markup).toContain("Create new Vendor from Agreement");
    expect(markup).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Create new Vendor from Agreement/);
    expect(markup).toContain("New Vendor from Agreement");
    expect(markup).toContain("Extract from Agreement");
    expect(markup).not.toContain('data-testid="start-draft"');
    expect(markup).not.toContain("Search authorized Vendors by name");
    expect(markup).not.toContain("Existing CreatorOps details");
    expect(markup).toContain("No represented Partner is created or linked.");
  });

  it("the checklist follows the wizard's steps and the note says nothing is created yet", () => {
    expect(markup).toContain("2. Signed Agreement");
    expect(markup).toContain("3. New Vendor details");
    expect(markup).toContain("4. Check for an existing Vendor");
    expect(markup).toContain("5. Create and start the Agreement");
    expect(markup).toContain("Nothing is created until you confirm the last step.");
    expect(markup).not.toContain("10. Review &amp; confirm");
  });

  it("a person who can create is not shown a permission note; one who cannot is told on the card and in the wizard", () => {
    expect(markup).not.toContain("You can review, but not create.");
    const reviewer = render(permissionsDto(), { onboarding: { mode: "new", counterpartyType: "VENDOR" } });
    expect(reviewer).toContain("creating a new Vendor needs permission");
    expect(reviewer).toContain("You can review, but not create.");
  });
});

describe("create-new deep link for a Partner", () => {
  it("keeps the platform choice: the wizard opens once a Partner card is chosen (never guessed)", () => {
    const markup = render(CAN_CREATE, { onboarding: { mode: "new", counterpartyType: "PARTNER" } });
    expect(markup).toContain("Instagram + YouTube Partner");
    expect(markup).not.toContain("onboarding-upload");
    expect(markup).not.toContain("Existing or new Partner");
  });
});

describe("a draft that exists", () => {
  it("shows the standard ten sections and no wizard, whatever the seed says", () => {
    const markup = render(CAN_CREATE, { agreement: agreementDto(), onboarding: { mode: "new", counterpartyType: "PARTNER" } });
    expect(markup).toContain("Contract source");
    expect(markup).toContain("Cross-verification");
    expect(markup).toContain("10. Review &amp; confirm");
    expect(markup).not.toContain("onboarding-upload");
    expect(markup).not.toContain("onboarding-extract");
    expect(markup).toContain('data-testid="extract-from-agreement"');
  });
});
