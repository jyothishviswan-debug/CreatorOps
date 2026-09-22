import { describe, expect, it } from "vitest";

import { candidate, duplicatesDto } from "./onboarding-fixtures";
import { confirmedRows, decisionRow, KYC_LATER_NOTE } from "./confirmed-values";
import { emptyForm, type OnboardingForm } from "./wizard-form";

const partnerForm: OnboardingForm = {
  ...emptyForm("PARTNER", ["instagram", "youtube"]),
  displayName: "Asha Rao",
  legalName: "Asha Rao Media",
  email: "asha@example.com",
  regionId: "Karnataka",
  accounts: [
    { platform: "instagram", locatorKind: "LINK", locator: "https://www.instagram.com/asha", pageName: "Asha Travels" },
    { platform: "youtube", locatorKind: "HANDLE", locator: "@ashatv", pageName: "" },
  ],
};

describe("confirmed onboarding values", () => {
  it("restates a new Partner: profile, region and one canonical locator per account", () => {
    const rows = confirmedRows({ type: "PARTNER", form: partnerForm, decision: { kind: "CREATE_NEW", acknowledged: false, reason: "" }, duplicates: duplicatesDto() });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["What happens", "Create a new Partner and start the Agreement draft."],
      ["Name", "Asha Rao"],
      ["Legal name", "Asha Rao Media"],
      ["Email", "asha@example.com"],
      ["Phone", "—"],
      ["Region", "Karnataka"],
      ["Instagram account", "Page link: https://www.instagram.com/asha · Asha Travels"],
      ["YouTube account", "Handle: @ashatv"],
    ]);
    expect(rows.find((row) => row.label === "Phone")?.muted).toBe(true);
  });

  it("a Vendor shows its type and no accounts", () => {
    const vendor = { ...emptyForm("VENDOR", []), displayName: "Acme Media", regionId: "Kerala", vendorType: "MANAGEMENT_COMPANY" };
    const rows = confirmedRows({ type: "VENDOR", form: vendor, decision: { kind: "CREATE_NEW", acknowledged: false, reason: "" }, duplicates: null });
    expect(rows.find((row) => row.label === "Vendor type")?.value).toBe("Management company");
    expect(rows.some((row) => /account/i.test(row.label))).toBe(false);
    expect(rows[0]!.value).toBe("Create a new Vendor and start the Agreement draft.");
  });

  it("Use existing names the chosen record and says nothing new is created", () => {
    const duplicates = duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x", displayName: "Asha R. Rao" })] });
    expect(decisionRow("PARTNER", { kind: "USE_EXISTING", ref: "prt_x" }, duplicates).value).toBe("Use the existing Partner: Asha R. Rao. No new Partner is created.");
    expect(decisionRow("VENDOR", { kind: "USE_EXISTING", ref: "gone" }, null).value).toBe("Use the existing Vendor you chose. No new Vendor is created.");
    expect(decisionRow("PARTNER", { kind: "NONE" }, null).muted).toBe(true);
  });

  it("records an overridden possible match with its reason", () => {
    const rows = confirmedRows({ type: "PARTNER", form: partnerForm, decision: { kind: "CREATE_NEW", acknowledged: true, reason: " Different person " }, duplicates: null });
    expect(rows.at(-1)).toEqual({ label: "Possible match", value: "You confirmed creating a new Partner anyway. Reason: Different person" });
  });

  it("never lists an identity detail and says where those are completed", () => {
    const text = JSON.stringify(confirmedRows({ type: "PARTNER", form: partnerForm, decision: { kind: "CREATE_NEW", acknowledged: false, reason: "" }, duplicates: null }));
    expect(text).not.toMatch(/PAN|Aadhaar|GSTIN|bank|IFSC/i);
    expect(KYC_LATER_NOTE).toMatch(/completed in the KYC section/);
  });
});
