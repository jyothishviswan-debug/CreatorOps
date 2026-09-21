import { describe, expect, it } from "vitest";

import type { CounterpartyPreviewDto } from "@/server/finance-agreements/workspace-dto";

import { NOT_AVAILABLE_IN_CREATOROPS } from "../format";
import { accountRows, contactRows, gstinStatusChip, kycRows, overallKycChip } from "./existing-details-logic";

function preview(over: Partial<CounterpartyPreviewDto> = {}): CounterpartyPreviewDto {
  return {
    source: "CreatorOps master data",
    type: "PARTNER",
    ref: "prt_1",
    displayName: "Asha Rao",
    legalName: "Asha Rao Media",
    email: "asha@example.com",
    phone: "+91 98765 43210",
    regions: ["Kerala"],
    status: "ACTIVE",
    partnerAccounts: [
      { partnerAccountRef: "pa_1", platform: "instagram", handle: "asha.ig", displayName: "Asha", profileUrl: null, status: "ACTIVE", primary: true },
      { partnerAccountRef: "pa_2", platform: "youtube", handle: null, displayName: "Asha TV", profileUrl: null, status: "INACTIVE", primary: false },
    ],
    kyc: { state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "MISSING" }, valuesVisible: true },
    gstinStatus: "MISSING",
    unavailableFields: [
      { fieldKey: "address", reason: "no_canonical_field" },
      { fieldKey: "pinCode", reason: "no_canonical_field" },
    ],
    ...over,
  };
}

describe("existing CreatorOps details rows", () => {
  it("lists name, phone, email and state; address and PIN read `Not available in CreatorOps`", () => {
    const rows = contactRows(preview());
    expect(rows.map((row) => row.key)).toEqual(["name", "legalName", "phone", "email", "state", "address", "pinCode"]);
    expect(rows.find((row) => row.key === "phone")?.value).toBe("+91 98765 43210");
    expect(rows.find((row) => row.key === "state")?.value).toBe("Kerala");
    for (const key of ["address", "pinCode"]) {
      const row = rows.find((item) => item.key === key)!;
      expect(row.value).toBe(NOT_AVAILABLE_IN_CREATOROPS);
      expect(row.muted).toBe(true);
    }
  });
  it("shows an em dash for a missing value - never an invented one", () => {
    const rows = contactRows(preview({ email: null, phone: null, regions: [], legalName: null, unavailableFields: [] }));
    expect(rows.map((row) => row.key)).toEqual(["name", "phone", "email", "state"]);
    expect(rows.find((row) => row.key === "email")?.value).toBe("—");
    expect(rows.find((row) => row.key === "state")?.value).toBe("—");
  });
  it("labels a Vendor row correctly", () => {
    expect(contactRows(preview({ type: "VENDOR", partnerAccounts: [] }))[0]!.label).toBe("Vendor name");
  });
});

describe("KYC status chips", () => {
  it("shows PAN, Aadhaar, Bank and GST certificate for a Partner, as status text", () => {
    const rows = kycRows(preview());
    expect(rows.map((row) => row.label)).toEqual(["PAN", "Aadhaar", "Bank details", "GST certificate"]);
    expect(rows.map((row) => row.chip.label)).toEqual(["Available", "Missing", "Missing", "Not applicable"]);
  });
  it("has no Aadhaar row for a Vendor", () => {
    expect(kycRows(preview({ type: "VENDOR" })).map((row) => row.key)).toEqual(["pan", "bank", "gst"]);
  });
  it("reads `Restricted` when the component detail is withheld, and never a value", () => {
    const restricted = preview({ kyc: { state: "MISSING", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }, valuesVisible: false }, gstinStatus: "RESTRICTED" });
    expect(kycRows(restricted).every((row) => row.chip.label === "Restricted")).toBe(true);
    expect(gstinStatusChip(restricted.gstinStatus).label).toBe("Restricted");
    expect(JSON.stringify([contactRows(restricted), kycRows(restricted), accountRows(restricted)])).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
  });
  it("carries the overall KYC state and GSTIN status as text", () => {
    expect(overallKycChip(preview()).label).toBe("Incomplete");
    expect(gstinStatusChip("PRESENT").label).toBe("On record");
    expect(gstinStatusChip("MISSING").label).toBe("Not on record");
    expect(gstinStatusChip("NOT_APPLICABLE").label).toBe("Not applicable");
    expect(gstinStatusChip("INCOMPLETE").label).toBe("Incomplete");
  });
});

describe("Partner Account rows", () => {
  it("shows platform + handle first and flags inactive accounts", () => {
    const rows = accountRows(preview());
    expect(rows[0]).toMatchObject({ platform: "Instagram", title: "@asha.ig", inactive: false });
    expect(rows[1]).toMatchObject({ platform: "YouTube", title: "Asha TV", inactive: true });
  });
  it("is empty for a Vendor", () => {
    expect(accountRows(preview({ type: "VENDOR", partnerAccounts: [] }))).toEqual([]);
  });
});
