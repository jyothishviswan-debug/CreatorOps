import { describe, expect, it } from "vitest";

import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_TEXT_PAGES } from "../testing/sample-contract";
import { CORE_COMMERCIAL_ANY_OF, CORE_REQUIRED_FIELDS, MIN_FIELDS_FOR_PARTIAL, classifyExtraction, splitRestricted } from "./extraction-result";
import { extractAgreementFields } from "./field-extractors";
import type { ExtractedFieldProposal } from "./extraction-types";
import type { PdfTextResult } from "./pdf-text";

const okPdf: PdfTextResult = { ok: true, pages: ["x"], pageCount: 1, totalChars: 1000, truncated: { chars: false } };

function proposals(...lines: string[]): ExtractedFieldProposal[] {
  return extractAgreementFields([lines.join("\n")]).fields;
}

describe("classifyExtraction", () => {
  it("maps every pdf failure to MANUAL_REVIEW_REQUIRED with that reason and ignores any fields", () => {
    const stray = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Fixed Fee: Rs. 5,000");
    for (const reason of ["no_extractable_text", "unreadable_pdf", "encrypted", "too_many_pages", "timeout"] as const) {
      expect(classifyExtraction({ ok: false, reason }, stray)).toEqual({ status: "MANUAL_REVIEW_REQUIRED", reasons: [reason], missingCore: [], fieldCount: 0 });
    }
  });

  it("is EXTRACTED when the required core is present", () => {
    const fields = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Fixed Fee: Rs. 5,000", "Currency: INR");
    expect(classifyExtraction(okPdf, fields)).toEqual({ status: "EXTRACTED", reasons: [], missingCore: [], fieldCount: fields.length });
  });

  it("accepts any one commercial-structure field as the commercial core", () => {
    expect(CORE_REQUIRED_FIELDS).toEqual(["counterpartyName", "effectiveDate"]);
    expect(CORE_COMMERCIAL_ANY_OF).toEqual(["fixedComponent", "monthlyRequiredQualifyingContentCount", "incentive"]);
    const fields = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Monthly Deliverables: 8 reels");
    expect(classifyExtraction(okPdf, fields).status).toBe("EXTRACTED");
  });

  it("is PARTIAL when enough was read but a core requirement is missing", () => {
    const noDate = proposals("Collaborator Name: Acme Studio", "Fixed Fee: Rs. 5,000", "Currency: INR", "Payment Cycle: Monthly");
    expect(classifyExtraction(okPdf, noDate)).toMatchObject({ status: "PARTIAL", reasons: ["missing_core_fields"], missingCore: ["effectiveDate"] });
    const noCommercial = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Payment Cycle: Monthly");
    expect(classifyExtraction(okPdf, noCommercial)).toMatchObject({ status: "PARTIAL", missingCore: ["commercial_structure"] });
  });

  it("requires a currency whenever an amount was extracted", () => {
    const synthetic = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Fixed Fee: Rs. 5,000").filter((f) => f.fieldKey !== "currency");
    expect(classifyExtraction(okPdf, synthetic)).toMatchObject({ status: "PARTIAL", missingCore: ["currency"] });
  });

  it("is MANUAL_REVIEW_REQUIRED (few_fields) when fewer than the minimum proposals exist", () => {
    expect(MIN_FIELDS_FOR_PARTIAL).toBe(3);
    // DELIBERATE CHANGE: a document with no incentive/bonus/slab language now always gains a LOW-confidence
    // "no_incentive_language_found" suggestion (see incentive-target-rules.ts), so a 2-line fixture without that
    // wording no longer stays at 2 fields. One line (1 real field + the incentive suggestion = 2) keeps this test's
    // premise - "fewer than the minimum" - meaningful; classifyExtraction's commercial_structure check was updated
    // alongside it so that suggestion alone never counts as a found commercial structure.
    const fields = proposals("Collaborator Name: Acme Studio");
    expect(fields).toHaveLength(2);
    expect(classifyExtraction(okPdf, fields)).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED", reasons: ["few_fields", "missing_core_fields"] });
    expect(classifyExtraction(okPdf, [])).toMatchObject({ status: "MANUAL_REVIEW_REQUIRED", reasons: ["few_fields", "missing_core_fields"], fieldCount: 0 });
  });

  it("downgrades EXTRACTED to PARTIAL for truncated text, an ambiguous core field or a rule error", () => {
    const fields = proposals("Collaborator Name: Acme Studio", "Effective Date: 1 April 2025", "Fixed Fee: Rs. 5,000", "Currency: INR");
    expect(classifyExtraction({ ...okPdf, truncated: { chars: true } }, fields)).toMatchObject({ status: "PARTIAL", reasons: ["text_truncated"] });
    expect(classifyExtraction(okPdf, fields, [{ code: "rule_error:dates" }])).toMatchObject({ status: "PARTIAL", reasons: ["extractor_rule_error"] });
    const ambiguous = proposals("Collaborator Name: Acme Studio", "Party B: Other Studio", "Effective Date: 1 April 2025", "Fixed Fee: Rs. 5,000", "Currency: INR");
    expect(ambiguous.find((f) => f.fieldKey === "counterpartyName")!.confidence).toBe("LOW");
    expect(classifyExtraction(okPdf, ambiguous)).toMatchObject({ status: "PARTIAL", reasons: ["ambiguous_core_field"] });
  });

  it("classifies the full synthetic contract as EXTRACTED (completeness only)", () => {
    const { fields, warnings } = extractAgreementFields(SAMPLE_CONTRACT_TEXT_PAGES);
    expect(classifyExtraction(okPdf, fields, warnings).status).toBe("EXTRACTED");
  });
});

describe("splitRestricted", () => {
  const { fields } = extractAgreementFields(SAMPLE_CONTRACT_TEXT_PAGES);
  const split = splitRestricted(fields);
  const ordinaryJson = JSON.stringify(split.ordinary);

  it("keeps a snippet for every field, but only in the restricted part", () => {
    expect(split.restricted.rawSnippets).toHaveLength(fields.length);
    for (const entry of split.restricted.rawSnippets) expect(entry.rawSnippet.length).toBeGreaterThan(0);
    expect(ordinaryJson).not.toContain("rawSnippet");
    for (const proposal of split.ordinary) expect(Object.keys(proposal)).not.toContain("rawSnippet");
    // the snippet text itself is absent from the ordinary record
    for (const { rawSnippet } of split.restricted.rawSnippets) expect(ordinaryJson).not.toContain(rawSnippet);
  });

  it("moves identity VALUES to the restricted part and strips them from ordinary proposals", () => {
    const identity = new Map(split.restricted.identityValues.map((entry) => [entry.fieldKey, entry.normalizedValue]));
    expect([...identity.keys()].sort()).toEqual(["aadhaarNumber", "bankAccountNumber", "gstin", "ifsc", "panHolderName", "panNumber"]);
    expect(identity.get("aadhaarNumber")).toBe(SAMPLE_AADHAAR);
    expect(identity.get("panNumber")).toBe("ABCPE1234F");
    // ID-shaped identity values never appear in the ordinary record. (The PAN holder NAME is a name, not an identifier: it may
    // legitimately overlap the ordinary counterparty name - see the dedicated test below - but it is never its own ordinary value.)
    for (const [key, value] of identity) if (key !== "panHolderName") expect(ordinaryJson.toLowerCase()).not.toContain(value.toLowerCase());
    const ordinaryPan = split.ordinary.find((p) => p.fieldKey === "panNumber")!;
    expect(ordinaryPan).toMatchObject({ restricted: true, confidence: "HIGH", page: 1, requiresHumanConfirmation: true });
    expect("normalizedValue" in ordinaryPan).toBe(false);
  });

  it("keeps ordinary values (with metadata) for non-restricted fields", () => {
    const state = split.ordinary.find((p) => p.fieldKey === "state")!;
    expect(state).toMatchObject({ normalizedValue: "Karnataka", restricted: false, page: 1 });
    expect(split.ordinary).toHaveLength(fields.length);
  });

  it("withholds an ordinary value that quotes an identity value, as defence in depth", () => {
    const pan = fields.find((f) => f.fieldKey === "panNumber")!;
    const tainted: ExtractedFieldProposal = { ...fields.find((f) => f.fieldKey === "servicesMandated")!, normalizedValue: `Bill under PAN ${pan.normalizedValue} monthly` } as ExtractedFieldProposal;
    const out = splitRestricted([pan, tainted]);
    const ordinary = out.ordinary.find((p) => p.fieldKey === "servicesMandated")!;
    expect("normalizedValue" in ordinary).toBe(false);
    expect(ordinary.warnings).toContain("value_withheld_contains_restricted_data");
    expect(JSON.stringify(out.ordinary)).not.toContain(String(pan.normalizedValue));
  });

  it("a PAN holder NAME inside the ordinary counterparty name is NOT a leak (only ID-shaped identity values are)", () => {
    const holder = { fieldKey: "panHolderName", normalizedValue: "Sample Creator", page: 1, confidence: "HIGH", warnings: [], rawSnippet: "PAN holder: Sample Creator", requiresHumanConfirmation: true, restricted: true } as unknown as ExtractedFieldProposal;
    const name = { fieldKey: "counterpartyName", normalizedValue: "Sample Creator Studio", page: 1, confidence: "HIGH", warnings: [], rawSnippet: "Sample Creator Studio", requiresHumanConfirmation: true, restricted: false } as unknown as ExtractedFieldProposal;
    const out = splitRestricted([holder, name]);
    const ordinary = out.ordinary.find((p) => p.fieldKey === "counterpartyName")!;
    expect(ordinary).toMatchObject({ normalizedValue: "Sample Creator Studio" });
    expect(ordinary.warnings).not.toContain("value_withheld_contains_restricted_data");
    // ...while the holder name itself still lives only in the restricted part.
    expect("normalizedValue" in out.ordinary.find((p) => p.fieldKey === "panHolderName")!).toBe(false);
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(fields);
    splitRestricted(fields);
    expect(JSON.stringify(fields)).toBe(before);
  });
});
