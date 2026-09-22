import { describe, expect, it } from "vitest";

import { permissionsDto } from "../intake-fixtures";
import {
  accountPlatformsFor,
  counterpartyTypeOfChoice,
  createRight,
  DEFAULT_ONBOARDING_MODE,
  EMPTY_ONBOARDING_SELECTION,
  existingModeTitle,
  initialOnboardingSelection,
  isWizardActive,
  newModeTitle,
  onboardingModeOptions,
  canUseExisting,
} from "./onboarding-mode";

describe("onboarding mode choice", () => {
  it("defaults to the existing-counterparty flow so nothing changes for the current form", () => {
    expect(DEFAULT_ONBOARDING_MODE).toBe("existing");
    expect(EMPTY_ONBOARDING_SELECTION).toEqual({ mode: "existing", choice: null });
    expect(isWizardActive(EMPTY_ONBOARDING_SELECTION)).toBe(false);
  });

  it("words the two cards for a Partner and for a Vendor", () => {
    expect(existingModeTitle("PARTNER")).toBe("Select existing Partner");
    expect(newModeTitle("PARTNER")).toBe("Create new Partner from Agreement");
    expect(existingModeTitle("VENDOR")).toBe("Select existing Vendor");
    expect(newModeTitle("VENDOR")).toBe("Create new Vendor from Agreement");
    const options = onboardingModeOptions("VENDOR", permissionsDto({ canCreateVendor: true }));
    expect(options.map((option) => [option.value, option.title])).toEqual([["existing", "Select existing Vendor"], ["new", "Create new Vendor from Agreement"]]);
  });

  it("tells a reviewer who cannot create so on the card, without hiding the choice", () => {
    const cannot = onboardingModeOptions("PARTNER", permissionsDto());
    expect(cannot).toHaveLength(2);
    expect(cannot[1]!.description).toMatch(/needs permission/);
    expect(onboardingModeOptions("PARTNER", permissionsDto({ canCreatePartner: true }))[1]!.description).toMatch(/check for an existing Partner/);
    // the right that applies is the one for THIS type
    expect(onboardingModeOptions("VENDOR", permissionsDto({ canCreatePartner: true }))[1]!.description).toMatch(/needs permission/);
  });

  it("the wizard opens once the person chose to create AND which kind", () => {
    expect(isWizardActive({ mode: "new", choice: null })).toBe(false);
    expect(isWizardActive({ mode: "new", choice: "IG_YT_PARTNER" })).toBe(true);
    expect(isWizardActive({ mode: "existing", choice: "VENDOR" })).toBe(false);
  });

  it("seeds a deep link: a Vendor has one card; a Partner still chooses the platform", () => {
    expect(initialOnboardingSelection(undefined)).toEqual(EMPTY_ONBOARDING_SELECTION);
    expect(initialOnboardingSelection({ mode: "new", counterpartyType: "VENDOR" })).toEqual({ mode: "new", choice: "VENDOR" });
    expect(initialOnboardingSelection({ mode: "new", counterpartyType: "PARTNER" })).toEqual({ mode: "new", choice: null });
  });

  it("maps a card to its counterparty type and Partner Account platforms (one Partner, several accounts)", () => {
    expect(accountPlatformsFor("IG_YT_PARTNER")).toEqual(["instagram", "youtube"]);
    expect(accountPlatformsFor("YOUTUBE_PARTNER")).toEqual(["youtube"]);
    expect(accountPlatformsFor("VENDOR")).toEqual([]);
    expect(accountPlatformsFor(null)).toEqual([]);
    expect(counterpartyTypeOfChoice("INSTAGRAM_PARTNER")).toBe("PARTNER");
    expect(counterpartyTypeOfChoice("VENDOR")).toBe("VENDOR");
    expect(counterpartyTypeOfChoice(null)).toBeNull();
  });
});

describe("the right to create", () => {
  const all = permissionsDto({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });

  it("needs manage_agreements first, then the owning create right, then (Partner Accounts) the account right", () => {
    expect(createRight(all, "PARTNER", true)).toEqual({ canCreate: true, reason: null, missing: null });
    expect(createRight(permissionsDto({ ...all, canManage: false }), "PARTNER", true)).toMatchObject({ canCreate: false, missing: "MANAGE" });
    expect(createRight(permissionsDto({ canCreateVendor: true }), "PARTNER", true)).toMatchObject({ canCreate: false, missing: "COUNTERPARTY" });
    expect(createRight(permissionsDto({ canCreatePartner: true }), "PARTNER", true)).toMatchObject({ canCreate: false, missing: "ACCOUNTS", reason: expect.stringMatching(/Partner Accounts/) });
    expect(createRight(permissionsDto({ canCreatePartner: true }), "PARTNER", false).canCreate).toBe(true);
  });

  it("a Vendor needs only the Vendor create right", () => {
    expect(createRight(permissionsDto({ canCreateVendor: true }), "VENDOR", false).canCreate).toBe(true);
    expect(createRight(permissionsDto({ canCreatePartner: true, canManagePartnerAccounts: true }), "VENDOR", false)).toMatchObject({ canCreate: false, missing: "COUNTERPARTY", reason: expect.stringMatching(/new Vendor/) });
  });

  it("the reason says what CAN be done instead", () => {
    expect(createRight(permissionsDto(), "PARTNER", false).reason).toMatch(/Select an existing Partner, or ask someone with access to create it/);
  });

  it("using an existing record needs only manage_agreements", () => {
    expect(canUseExisting(permissionsDto())).toBe(true);
    expect(canUseExisting(permissionsDto({ canManage: false }))).toBe(false);
  });
});
