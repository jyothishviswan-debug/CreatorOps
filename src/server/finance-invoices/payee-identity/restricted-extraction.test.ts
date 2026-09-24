import { describe, expect, it } from "vitest";

import { buildPayeeIdentityEvidence, extractRestrictedPayeeIdentityEvidence, type RestrictedPayeeIdentityEvidence } from "./restricted-extraction";

// Step 16D section 20: unit tests for the restricted GST/address/bank extractors, and the
// confidence -> hard-comparison gate. Pure functions, no Firestore, no PDF bytes - operates directly
// on already-normalized page text, exactly like field-extractors.test.ts does for the ordinary
// fields.

describe("extractRestrictedPayeeIdentityEvidence - tax registration (GSTIN)", () => {
  it("finds a GSTIN right after an explicit GSTIN label (HIGH confidence)", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Acme Studios Pvt Ltd\nGSTIN: 29ABCDE1234F1Z5\nBengaluru"]);
    expect(result.taxRegistration).toEqual({ value: "29ABCDE1234F1Z5", confidence: "HIGH", page: 1 });
  });

  it.each(["GST No: 29ABCDE1234F1Z5", "GST No.: 29ABCDE1234F1Z5", "GST Number: 29ABCDE1234F1Z5", "Supplier GSTIN: 29ABCDE1234F1Z5", "Vendor GSTIN: 29ABCDE1234F1Z5", "Tax Registration No: 29ABCDE1234F1Z5"])(
    "accepts the common label variant %s",
    (line) => {
      const result = extractRestrictedPayeeIdentityEvidence([line]);
      expect(result.taxRegistration?.value).toBe("29ABCDE1234F1Z5");
    },
  );

  it("normalizes proximity: a value found further down the label's window is MEDIUM, not HIGH", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["GSTIN\n(as printed on the supplier's registration certificate) 29ABCDE1234F1Z5"]);
    expect(result.taxRegistration?.confidence).toBe("MEDIUM");
  });

  it("rejects an unrelated alphanumeric string with no nearby GST label", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Reference code: 29ABCDE1234F1Z5 for support queries only"]);
    expect(result.taxRegistration).toBeNull();
  });

  it("rejects a GST-shaped label with no valid-format value nearby", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["GSTIN: Applied for, will be shared shortly"]);
    expect(result.taxRegistration).toBeNull();
  });

  it("ambiguous/low-confidence case: two different GSTIN-shaped candidates near the same label", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["GSTIN: 29ABCDE1234F1Z5 (old: 27ZZZZZ9999Z1Z1)"]);
    expect(result.taxRegistration?.confidence).toBe("LOW");
  });

  it("reports the correct 1-indexed source page", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["No GST info on this page", "GSTIN: 29ABCDE1234F1Z5"]);
    expect(result.taxRegistration?.page).toBe(2);
  });
});

describe("extractRestrictedPayeeIdentityEvidence - bank account evidence", () => {
  it("finds an account number after an 'Account Number' label", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Account Number: 000123456789"]);
    expect(result.bankIdentifier).toEqual({ value: "000123456789", confidence: "HIGH", page: 1 });
  });

  it("finds an account number after 'A/C No.'", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["A/C No.: 000123456789"]);
    expect(result.bankIdentifier?.value).toBe("000123456789");
  });

  it("finds a beneficiary account number", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Beneficiary Account Number: 000123456789"]);
    expect(result.bankIdentifier?.value).toBe("000123456789");
  });

  it("rejects an unrelated numeric sequence with no nearby bank label", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Invoice Number: 000123456789"]);
    expect(result.bankIdentifier).toBeNull();
  });

  it("ambiguous/low-confidence case: two candidate numbers near the same bank label", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Account Number: 000123456789 (previously 000198765432)"]);
    expect(result.bankIdentifier?.confidence).toBe("LOW");
  });
});

describe("extractRestrictedPayeeIdentityEvidence - address", () => {
  it("captures a multiline supplier address block", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["From: Acme Studios Pvt Ltd\n12 MG Road\nBengaluru, Karnataka 560001\n\nInvoice Number: INV-1"]);
    expect(result.businessAddress?.confidence).toBe("HIGH");
    expect(result.businessAddress?.value).toBe("12 MG Road, Bengaluru, Karnataka 560001");
  });

  it("does not misattribute a bill-to customer address to the supplier", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["From: Acme Studios Pvt Ltd\n12 MG Road\nBengaluru\nBill To: CreatorOps Media\n99 Customer Lane"]);
    expect(result.businessAddress?.value).not.toMatch(/Customer Lane/);
  });

  it("does not misattribute a bank branch address to the supplier", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["From: Acme Studios Pvt Ltd\n12 MG Road\nBengaluru\nBranch: HSR Layout Branch, Bengaluru"]);
    expect(result.businessAddress?.value).not.toMatch(/HSR Layout/);
  });

  it("stops the address block before a GSTIN line with no blank-line separator", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Supplier: Acme Studios Pvt Ltd\n12 MG Road, Bengaluru\nGSTIN: 29ABCDE1234F1Z5\nAccount Number: 000123456789"]);
    expect(result.businessAddress?.value).toBe("12 MG Road, Bengaluru");
    expect(result.taxRegistration?.value).toBe("29ABCDE1234F1Z5");
    expect(result.bankIdentifier?.value).toBe("000123456789");
  });

  it("returns unavailable when there is no supplier/vendor/from/payee block at all", () => {
    const result = extractRestrictedPayeeIdentityEvidence(["Bill To: CreatorOps Media\n99 Customer Lane\n\nInvoice Number: INV-1"]);
    expect(result.businessAddress).toBeNull();
  });
});

describe("confidence gate: buildPayeeIdentityEvidence", () => {
  const canonical = { expectedName: "Acme Studios Private Limited", expectedTaxId: "29ABCDE1234F1Z5", expectedAddress: "12 MG Road, Bengaluru", expectedBankIdentifier: "000123456789" };

  it("HIGH confidence extracted GST participates in the exact hard comparison", () => {
    const restricted: RestrictedPayeeIdentityEvidence = { taxRegistration: { value: "29ABCDE1234F1Z5", confidence: "HIGH", page: 1 }, businessAddress: null, bankIdentifier: null };
    const evidence = buildPayeeIdentityEvidence(canonical, null, restricted);
    expect(evidence.extractedTaxId).toBe("29ABCDE1234F1Z5");
  });

  it("LOW confidence extracted GST is withheld - never reaches the matcher as a usable value", () => {
    const restricted: RestrictedPayeeIdentityEvidence = { taxRegistration: { value: "29ABCDE1234F1Z5", confidence: "LOW", page: 1 }, businessAddress: null, bankIdentifier: null };
    const evidence = buildPayeeIdentityEvidence(canonical, null, restricted);
    expect(evidence.extractedTaxId).toBeNull();
  });

  it("LOW confidence extracted bank identifier is withheld the same way", () => {
    const restricted: RestrictedPayeeIdentityEvidence = { taxRegistration: null, businessAddress: null, bankIdentifier: { value: "000123456789", confidence: "LOW", page: 1 } };
    const evidence = buildPayeeIdentityEvidence(canonical, null, restricted);
    expect(evidence.extractedBankIdentifier).toBeNull();
  });

  it("null restricted evidence (no document / no extractable text) withholds every restricted field", () => {
    const evidence = buildPayeeIdentityEvidence(canonical, "Acme Studios", null);
    expect(evidence.extractedTaxId).toBeNull();
    expect(evidence.extractedAddress).toBeNull();
    expect(evidence.extractedBankIdentifier).toBeNull();
    expect(evidence.extractedName).toBe("Acme Studios");
  });

  it("never echoes a raw restricted value into a property whose name matches the forbidden identity-value vocabulary", () => {
    // A structural proof alongside finance-invoices-static.test.ts's source-scan guard: the shape
    // returned here only ever uses expectedTaxId/extractedTaxId/expectedBankIdentifier/
    // extractedBankIdentifier - never gstin/accountNumber/ifsc/accountHolderName.
    const restricted: RestrictedPayeeIdentityEvidence = { taxRegistration: { value: "29ABCDE1234F1Z5", confidence: "HIGH", page: 1 }, businessAddress: null, bankIdentifier: { value: "000123456789", confidence: "HIGH", page: 1 } };
    const evidence = buildPayeeIdentityEvidence(canonical, null, restricted);
    expect(Object.keys(evidence).sort()).toEqual(["expectedAddress", "expectedBankIdentifier", "expectedName", "expectedTaxId", "extractedAddress", "extractedBankIdentifier", "extractedName", "extractedTaxId"].sort());
  });
});
