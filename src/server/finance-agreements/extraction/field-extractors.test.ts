import { describe, expect, it } from "vitest";

import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_TEXT_PAGES } from "../testing/sample-contract";
import { extractAgreementFields } from "./field-extractors";
import { EXTRACTED_FIELD_KEYS, RESTRICTED_EXTRACTED_FIELD_KEYS, type ExtractedFieldKey, type ExtractedFieldProposal } from "./extraction-types";

function run(...pages: string[][]) {
  return extractAgreementFields(pages.map((lines) => lines.join("\n")));
}

function field<K extends ExtractedFieldKey>(result: ReturnType<typeof run>, key: K): Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined {
  return result.fields.find((f) => f.fieldKey === key) as Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined;
}

describe("extractAgreementFields: full synthetic contract", () => {
  const result = extractAgreementFields(SAMPLE_CONTRACT_TEXT_PAGES);

  it("proposes every field of the sample with the expected normalized value and page", () => {
    const expected: Array<[ExtractedFieldKey, unknown, number]> = [
      ["counterpartyName", "Sample Creator Studio", 1],
      ["contactNumber", "+919876543210", 1],
      ["emailAddress", "hello@samplecreator.example", 1],
      ["state", "Karnataka", 1],
      ["address", "12, Test Street, Sample Nagar, Bengaluru - 560001", 1],
      ["pinCode", "560001", 1],
      ["gstin", "29ABCPE1234F1Z5", 1],
      ["panNumber", "ABCPE1234F", 1],
      ["panHolderName", "Sample Creator", 1],
      ["aadhaarNumber", SAMPLE_AADHAAR, 1],
      ["bankAccountNumber", "123456789012", 1],
      ["ifsc", "HDFC0001234", 1],
      ["collaboratorPageLink", "https://instagram.com/sample.creator", 1],
      ["collaboratorPageName", "Sample Creator Official", 1],
      ["agreementNumber", "CO/2025/0042", 1],
      ["signedDate", "2025-03-05", 1],
      ["effectiveDate", "2025-04-01", 2],
      ["terminationDate", "2026-03-31", 2],
      ["currency", "INR", 2],
      ["paymentCycle", "MONTHLY", 2],
      ["fixedComponent", { applicable: true, amountMinor: 2_500_000 }, 2],
      ["monthlyRequiredQualifyingContentCount", 12, 2],
      ["qualifyingUnit", "reel", 2],
      ["accountTransferFee", { applicable: true, amountMinor: 1_000_000, details: null }, 2],
      ["advancePayment", { applicable: false, details: null, amountMinor: null }, 2],
      ["invoiceRequired", true, 2],
      ["paymentDueTerms", "Net 30", 2],
      ["renewalTerms", "This Agreement may be renewed for a further term by mutual written consent.", 2],
      ["lfcSfc", { byFormat: { podcast: "LFC", reels: "SFC", shorts: "SFC", "youtube video": "LFC" } }, 3],
    ];
    for (const [key, value, page] of expected) {
      const found = field(result, key);
      expect(found, key).toBeDefined();
      expect(found!.normalizedValue, key).toEqual(value);
      expect(found!.page, key).toBe(page);
    }
  });

  it("every proposal needs human confirmation, has a bounded snippet, and the restricted flag matches the identity set", () => {
    const restricted = new Set<string>(RESTRICTED_EXTRACTED_FIELD_KEYS);
    for (const proposal of result.fields) {
      expect(proposal.requiresHumanConfirmation).toBe(true);
      expect(proposal.rawSnippet.length).toBeGreaterThan(0);
      expect(proposal.rawSnippet.length).toBeLessThanOrEqual(300);
      expect(proposal.page).toBeGreaterThanOrEqual(1);
      expect(proposal.restricted).toBe(restricted.has(proposal.fieldKey));
      expect(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).toContain(proposal.confidence);
    }
  });

  it("emits fields in registry order, each at most once, only from the known key set", () => {
    const keys = result.fields.map((f) => f.fieldKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => (EXTRACTED_FIELD_KEYS as readonly string[]).includes(key))).toBe(true);
    const order = keys.map((key) => EXTRACTED_FIELD_KEYS.indexOf(key));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("never proposes an agreement status or type", () => {
    const keys = result.fields.map((f) => f.fieldKey as string);
    for (const banned of ["status", "agreementStatus", "agreementType", "type"]) expect(keys).not.toContain(banned);
    expect(JSON.stringify(result.fields.map((f) => f.normalizedValue))).not.toMatch(/FIXED_ONLY|FIXED_PLUS|UNSPECIFIED/);
  });

  it("is deterministic", () => {
    expect(extractAgreementFields(SAMPLE_CONTRACT_TEXT_PAGES)).toEqual(result);
  });

  it("assigns coarse confidence: strict label-anchored identity HIGH, contact facts capped at MEDIUM, ambiguous dates MEDIUM", () => {
    expect(field(result, "panNumber")!.confidence).toBe("HIGH");
    expect(field(result, "gstin")!.confidence).toBe("HIGH");
    expect(field(result, "contactNumber")!.confidence).toBe("MEDIUM");
    expect(field(result, "address")!.confidence).toBe("MEDIUM");
    expect(field(result, "pinCode")!.confidence).toBe("LOW"); // derived from the address, not label-anchored
    expect(field(result, "effectiveDate")!.confidence).toBe("MEDIUM");
    expect(field(result, "effectiveDate")!.warnings).toContain("day_month_order_assumed_dd_mm");
    expect(field(result, "signedDate")!.confidence).toBe("HIGH");
  });

  it("emits the incentive slabs and the warning-only target with affectsPayment:false", () => {
    const incentive = field(result, "incentive")!;
    expect(incentive.normalizedValue.applicable).toBe(true);
    expect(incentive.normalizedValue.slabs).toEqual([
      { slabRef: "slab_1", metricId: "views", lowerBound: 10_000, upperBound: 50_000, unit: "views", amountMinor: 200_000, description: "10,000 to 50,000 views: Rs. 2,000" },
      { slabRef: "slab_2", metricId: "views", lowerBound: 50_000, upperBound: null, unit: "views", amountMinor: 500_000, description: "Above 50,000 views: Rs. 5,000" },
    ]);
    expect(incentive.warnings).toContain("slab_boundaries_need_confirmation");
    const targets = field(result, "performanceTargets")!;
    expect(targets.normalizedValue).toEqual([{ targetRef: "target_1", metricId: "followerGrowth", targetValue: 5, unit: "percent per month", comparison: "at_least", affectsPayment: false }]);
    expect(targets.warnings).toContain("warning_only_target_never_affects_payment");
  });

  it("finds clause text under numbered headings and stops at the next heading", () => {
    expect(field(result, "terminationTerms")!.normalizedValue).toBe("Either party may terminate this Agreement by giving 30 days written notice.");
    expect(field(result, "servicesMandated")!.normalizedValue).toBe("The Collaborator shall publish reels and stories on the page as briefed.");
    expect(field(result, "noticeTerms")!.confidence).toBe("LOW"); // sentence-level, no "Notice Period" heading
  });
});

describe("contact / identity rules", () => {
  it("normalizes Indian mobiles and requires a label (or +91) for them", () => {
    expect(field(run(["Phone No.: 98765-43210"]), "contactNumber")?.normalizedValue).toBe("+919876543210");
    expect(field(run(["Contact Number 09876543210"]), "contactNumber")?.normalizedValue).toBe("+919876543210");
    expect(field(run(["Reach us on +91 98765 43210 anytime"]), "contactNumber")).toMatchObject({ normalizedValue: "+919876543210", confidence: "LOW" });
    expect(field(run(["Reach us on 9876543210 anytime"]), "contactNumber")).toBeUndefined();
    expect(field(run(["Mobile: 12345"]), "contactNumber")).toBeUndefined();
  });

  it("lowers confidence when a field has several distinct labeled values, and omits several unlabeled ones", () => {
    const two = run(["Mobile: 9876543210", "Phone: 9123456789"]);
    expect(field(two, "contactNumber")).toMatchObject({ normalizedValue: "+919876543210", confidence: "LOW" });
    expect(field(two, "contactNumber")!.warnings).toContain("multiple_distinct_values_found");
    const unlabeled = run(["a@one.example and b@two.example are mentioned"]);
    expect(field(unlabeled, "emailAddress")).toBeUndefined();
    expect(unlabeled.warnings).toContainEqual({ code: "ambiguous_value_omitted", fieldKey: "emailAddress", page: 1 });
    expect(field(run(["Write to Only@One.Example"]), "emailAddress")).toMatchObject({ normalizedValue: "only@one.example", confidence: "LOW" });
  });

  it("matches state only against canonical REGION_ZONES names and warns on anything else", () => {
    expect(field(run(["State: Jammu and Kashmir"]), "state")?.normalizedValue).toBe("Jammu & Kashmir");
    expect(field(run(["State: Telangana"]), "state")).toBeUndefined();
    expect(run(["State: Telangana"]).warnings).toContainEqual({ code: "state_not_in_canonical_list", fieldKey: "state" });
    expect(field(run(["Address: Plot 4, MG Road, Pune, Maharashtra 411001"]), "state")).toMatchObject({ normalizedValue: "Maharashtra", confidence: "LOW" });
  });

  it("reads a label-anchored address block, stopping at the next label", () => {
    const r = run(["Registered Address: Flat 2, Lake View,", "Kochi, Kerala 682001", "Phone: 9876543210"]);
    expect(field(r, "address")?.normalizedValue).toBe("Flat 2, Lake View, Kochi, Kerala 682001");
    expect(field(r, "pinCode")).toMatchObject({ normalizedValue: "682001", confidence: "LOW" });
    expect(field(run(["Email Address: me@x.example"]), "address")).toBeUndefined();
  });

  it("takes a PIN from a PIN label, never from a bare 6-digit number", () => {
    // DELIBERATE CHANGE: a conventional Indian PIN carries a space after the 3rd digit ("144 005", seen in real
    // contracts) - a LABEL-anchored spaced PIN is now accepted (and the space normalized away); only an UNLABELED
    // bare number stays rejected, and a labeled but unspaced PIN is unaffected.
    expect(field(run(["PIN Code: 400 001"]), "pinCode")).toMatchObject({ normalizedValue: "400001", confidence: "MEDIUM" });
    expect(field(run(["Pincode: 400001"]), "pinCode")).toMatchObject({ normalizedValue: "400001", confidence: "MEDIUM" });
    expect(field(run(["Reference 400001 in the ledger"]), "pinCode")).toBeUndefined();
    expect(field(run(["PIN: 012345"]), "pinCode")).toBeUndefined();
  });

  it("validates GSTIN shape (state code, format) and PAN shape (holder type)", () => {
    expect(field(run(["GST No: 27ABCPE1234F1Z5"]), "gstin")).toMatchObject({ normalizedValue: "27ABCPE1234F1Z5", confidence: "HIGH" });
    expect(field(run(["GSTIN: 99ABCPE1234F1Z5"]), "gstin")?.normalizedValue).toBe("99ABCPE1234F1Z5");
    expect(field(run(["GSTIN: 50ABCPE1234F1Z5"]), "gstin")).toBeUndefined(); // no such state code
    expect(field(run(["GSTIN: 27ABCPE1234F1X5"]), "gstin")).toBeUndefined(); // 14th char must be Z
    expect(field(run(["Registered under 27abcpe1234f1z5 (GST)"]), "gstin")).toMatchObject({ normalizedValue: "27ABCPE1234F1Z5", confidence: "MEDIUM" });
    expect(field(run(["PAN Number: ABCPE1234F"]), "panNumber")).toMatchObject({ normalizedValue: "ABCPE1234F", confidence: "HIGH" });
    expect(field(run(["PAN: ABCDE1234F"]), "panNumber")).toBeUndefined(); // 4th character D is not a holder type
    expect(field(run(["Ref ABCPE1234F attached"]), "panNumber")).toMatchObject({ confidence: "LOW" });
  });

  it("cross-checks PAN against the PAN embedded in the GSTIN", () => {
    const r = run(["PAN: ABCPE1234F", "GSTIN: 27ZZZZP9999Z1Z5"]);
    expect(field(r, "panNumber")!.warnings).toContain("pan_gstin_mismatch");
    expect(field(r, "gstin")!.warnings).toContain("pan_gstin_mismatch");
    const ok = run(["PAN: ABCPE1234F", "GSTIN: 27ABCPE1234F1Z5"]);
    expect(field(ok, "panNumber")!.warnings).not.toContain("pan_gstin_mismatch");
  });

  it("treats a PAN holder name as label-anchored free text", () => {
    expect(field(run(["Name as per PAN: Rahul Sharma"]), "panHolderName")).toMatchObject({ normalizedValue: "Rahul Sharma", confidence: "MEDIUM", restricted: true });
    expect(field(run(["Name: Rahul Sharma"]), "panHolderName")).toBeUndefined();
  });

  it("reads Aadhaar only when label-anchored, and is mask-safe", () => {
    expect(field(run([`Aadhaar Number: 2341 2341 2346`]), "aadhaarNumber")).toMatchObject({ normalizedValue: SAMPLE_AADHAAR, confidence: "HIGH", restricted: true });
    expect(field(run([`Aadhaar: 234123412345`]), "aadhaarNumber")).toMatchObject({ confidence: "MEDIUM" });
    expect(field(run([`Aadhaar: 234123412345`]), "aadhaarNumber")!.warnings).toContain("aadhaar_checksum_invalid");
    const masked = field(run(["Aadhaar No: XXXX XXXX 2346"]), "aadhaarNumber");
    expect(masked).toMatchObject({ normalizedValue: "XXXXXXXX2346", confidence: "LOW" });
    expect(masked!.warnings).toContain("aadhaar_masked");
    expect(field(run(["Number 2341 2341 2346 on file"]), "aadhaarNumber")).toBeUndefined();
    expect(field(run(["Aadhaar: 034123412346"]), "aadhaarNumber")).toBeUndefined(); // cannot start with 0/1
  });

  it("reads bank account (9-18 digits, label-anchored) and IFSC (shape)", () => {
    expect(field(run(["Bank Account Number: 1234 5678 9012"]), "bankAccountNumber")?.normalizedValue).toBe("123456789012");
    expect(field(run(["A/c No. 000123456789"]), "bankAccountNumber")?.normalizedValue).toBe("000123456789");
    expect(field(run(["Account Number: 12345"]), "bankAccountNumber")).toBeUndefined();
    expect(field(run(["Account Number: XXXXXX6789"]), "bankAccountNumber")).toBeUndefined();
    expect(field(run(["Account Transfer Fee: Rs. 1,000"]), "bankAccountNumber")).toBeUndefined();
    expect(field(run(["IFSC Code: sbin0001234"]), "ifsc")).toMatchObject({ normalizedValue: "SBIN0001234", confidence: "HIGH", restricted: true });
    expect(field(run(["IFSC: SBIN1001234"]), "ifsc")).toBeUndefined(); // 5th character must be 0
  });

  it("keeps identity values on the value side of a label, not on the next label's value", () => {
    const r = run(["PAN: N/A, GSTIN: 27ABCPE1234F1Z5"]);
    expect(field(r, "panNumber")).toBeUndefined();
    expect(field(r, "gstin")?.normalizedValue).toBe("27ABCPE1234F1Z5");
  });

  it("supports a value on the line after its label for strict formats", () => {
    const r = run(["IFSC Code", "HDFC0001234", "PAN Number", "ABCPE1234F"]);
    expect(field(r, "ifsc")?.normalizedValue).toBe("HDFC0001234");
    expect(field(r, "panNumber")?.normalizedValue).toBe("ABCPE1234F");
  });
});
