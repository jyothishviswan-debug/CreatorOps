import { describe, expect, it } from "vitest";

import { restrictedFinancialIdentityDocSchema } from "@/server/shared/restricted-financial-identity";

import { buildIdentityStatusSnapshot, deriveIdentityComponents } from "./identity-status";

const NOW = "2026-01-01T00:00:00.000Z";

function doc(over: Record<string, unknown> = {}) {
  return restrictedFinancialIdentityDocSchema.parse({ uid: "PARTNER:u", subjectType: "PARTNER", subjectRef: "ref", version: 1, updatedAt: NOW, updatedByUserRef: "x", ...over });
}
const BANK = { accountHolderName: "Holder Name", accountNumber: "123456789012", ifsc: "TEST0001234", bankName: "Bank", branchName: "Branch" };

describe("deriveIdentityComponents", () => {
  it("nothing recorded: everything MISSING (a Vendor's Aadhaar is NOT_APPLICABLE)", () => {
    expect(deriveIdentityComponents("PARTNER", null)).toEqual({ pan: "MISSING", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" });
    expect(deriveIdentityComponents("VENDOR", null)).toEqual({ pan: "MISSING", aadhaar: "NOT_APPLICABLE", gst: "MISSING", bank: "MISSING" });
  });

  it("reports presence per component", () => {
    const components = deriveIdentityComponents("PARTNER", doc({ pan: { number: "ABCDE1234F" }, aadhaar: { number: "234123412346" }, bank: BANK, gst: { applicable: true, number: "29ABCDE1234F1Z5" } }));
    expect(components).toEqual({ pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" });
  });

  it("gst: not applicable -> NOT_APPLICABLE; applicable without a number -> MISSING", () => {
    expect(deriveIdentityComponents("PARTNER", doc({ gst: { applicable: false } })).gst).toBe("NOT_APPLICABLE");
    expect(deriveIdentityComponents("PARTNER", doc({ gst: { applicable: true } })).gst).toBe("MISSING");
  });

  it("a Vendor ignores any Aadhaar on its record", () => {
    expect(deriveIdentityComponents("VENDOR", doc({ subjectType: "VENDOR", aadhaar: { number: "234123412346" } })).aadhaar).toBe("NOT_APPLICABLE");
  });
});

describe("buildIdentityStatusSnapshot", () => {
  it("AVAILABLE when pan + bank are present and gst is not applicable", () => {
    const snapshot = buildIdentityStatusSnapshot("VENDOR", doc({ subjectType: "VENDOR", pan: { number: "ABCDE1234F" }, bank: BANK, gst: { applicable: false } }), NOW);
    expect(snapshot).toEqual({ state: "AVAILABLE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "NOT_APPLICABLE", bank: "PRESENT" }, capturedAt: NOW });
  });

  it("INCOMPLETE when only some required components exist; MISSING when none", () => {
    expect(buildIdentityStatusSnapshot("PARTNER", doc({ pan: { number: "ABCDE1234F" } }), NOW).state).toBe("INCOMPLETE");
    expect(buildIdentityStatusSnapshot("PARTNER", null, NOW).state).toBe("MISSING");
  });

  it("carries STATUS only: no value of the source document appears anywhere in the snapshot", () => {
    const snapshot = buildIdentityStatusSnapshot("PARTNER", doc({ pan: { number: "ABCDE1234F" }, aadhaar: { number: "234123412346" }, bank: BANK, gst: { applicable: true, number: "29ABCDE1234F1Z5" } }), NOW);
    const text = JSON.stringify(snapshot);
    for (const secret of ["ABCDE1234F", "234123412346", "123456789012", "TEST0001234", "Holder Name", "29ABCDE1234F1Z5", "Bank", "Branch"]) expect(text).not.toContain(secret);
    expect(Object.keys(snapshot).sort()).toEqual(["capturedAt", "components", "state"]);
  });
});
