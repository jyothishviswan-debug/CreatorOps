import { describe, expect, it } from "vitest";

import {
  TWO_PARTY_AADHAAR,
  TWO_PARTY_ACCOUNT_NUMBER,
  TWO_PARTY_AGREEMENT_PAGES,
  TWO_PARTY_AGREEMENT_TEXT_PAGES,
  TWO_PARTY_CLIENT_EMAIL,
  TWO_PARTY_EMAIL,
  TWO_PARTY_FIXED_AMOUNT_MINOR,
  TWO_PARTY_IFSC,
  TWO_PARTY_PAN,
  TWO_PARTY_QUALIFYING_COUNT,
  TWO_PARTY_QUALIFYING_UNIT,
} from "../testing/two-party-service-agreement";
import { makeTextPdf } from "../testing/pdf-fixtures";
import { classifyExtraction, splitRestricted } from "./extraction-result";
import { extractAgreementFields } from "./field-extractors";
import { extractPdfText } from "./pdf-text";
import type { ExtractedFieldKey, ExtractedFieldProposal } from "./extraction-types";

// Step 14A: the "1st Party / 2nd Party" style agreement - a party-declaration recital, a numbered sub-clause services
// description, a "lower limit Fee" / ordinal due-day payment clause, and "For the <role>:" notice labels. Covers the
// party-role resolver (identity-rules.ts, term-rules.ts, commercial-rules.ts, party-roles.ts) end to end.

function field<K extends ExtractedFieldKey>(fields: ExtractedFieldProposal[], key: K): Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined {
  return fields.find((f) => f.fieldKey === key) as Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined;
}

describe("two-party service agreement: full synthetic replica", () => {
  const result = extractAgreementFields(TWO_PARTY_AGREEMENT_TEXT_PAGES);
  const fields = result.fields;

  it("attributes the counterparty's name from the party-declaration block (never the Client's)", () => {
    const name = field(fields, "counterpartyName")!;
    expect(name.normalizedValue).toBe("Asha Verma");
    expect(name.page).toBe(1);
    expect(name.confidence).toBe("MEDIUM");
    expect(name.warnings).toContain("role_attributed");
    expect(name.warnings).not.toContain("verify_party_attribution");
  });

  it("has no contact number anywhere in the document", () => {
    expect(field(fields, "contactNumber")).toBeUndefined();
  });

  it("attributes the email by the 'For the <role>:' label - the Service Provider's, never the Client's", () => {
    const email = field(fields, "emailAddress")!;
    expect(email.normalizedValue).toBe(TWO_PARTY_EMAIL);
    expect(email.normalizedValue).not.toBe(TWO_PARTY_CLIENT_EMAIL);
    expect(email.confidence).toBe("HIGH");
    expect(email.page).toBe(5);
    expect(email.warnings).toContain("role_attributed");
  });

  it("reads the counterparty's state, address (stopping before the PIN) and PIN - never the Client's registered office", () => {
    const state = field(fields, "state")!;
    expect(state.normalizedValue).toBe("Punjab");
    expect(state.warnings).toContain("role_attributed");

    const address = field(fields, "address")!;
    expect(address.normalizedValue).toBe("Plot 7, Rose Enclave, Near City Park, Model Town Road, Jalandhar - I, Jalandhar, Punjab, India");
    expect(address.normalizedValue).not.toMatch(/PIN/);
    expect(address.normalizedValue).not.toMatch(/Gurugram|CIN/);
    expect(address.page).toBe(1);
    expect(address.warnings).toContain("role_attributed");

    const pin = field(fields, "pinCode")!;
    expect(pin.normalizedValue).toBe("144001"); // the inner space in "144 001" is removed
    expect(pin.confidence).toBe("MEDIUM");
  });

  it("has no GSTIN, no page link and NO page name - the bank 'Account Name:' line is excluded", () => {
    expect(field(fields, "gstin")).toBeUndefined();
    expect(field(fields, "collaboratorPageLink")).toBeUndefined();
    expect(field(fields, "collaboratorPageName")).toBeUndefined();
  });

  it("reads Aadhaar, PAN and infers the PAN holder name from the same party-declaration block", () => {
    const aadhaar = field(fields, "aadhaarNumber")!;
    expect(aadhaar.normalizedValue).toBe(TWO_PARTY_AADHAAR);
    expect(aadhaar.confidence).toBe("HIGH");
    expect(aadhaar.restricted).toBe(true);

    const pan = field(fields, "panNumber")!;
    expect(pan.normalizedValue).toBe(TWO_PARTY_PAN);
    expect(pan.confidence).toBe("HIGH");
    expect(pan.restricted).toBe(true);

    const holder = field(fields, "panHolderName")!;
    expect(holder.normalizedValue).toBe("Asha Verma");
    expect(holder.confidence).toBe("MEDIUM");
    expect(holder.warnings).toContain("holder_inferred_from_party_block");
    expect(holder.restricted).toBe(true);
  });

  it("reads the bank account and IFSC from clause 5.2", () => {
    const account = field(fields, "bankAccountNumber")!;
    expect(account.normalizedValue).toBe(TWO_PARTY_ACCOUNT_NUMBER);
    expect(account.confidence).toBe("HIGH");
    expect(account.page).toBe(3);

    const ifsc = field(fields, "ifsc")!;
    expect(ifsc.normalizedValue).toBe(TWO_PARTY_IFSC);
    expect(ifsc.confidence).toBe("HIGH");
  });

  it("cross-checks the numeric date against its words-in-parentheses definition, raising confidence and dropping the ambiguity warning", () => {
    const signed = field(fields, "signedDate")!;
    expect(signed.normalizedValue).toBe("2025-11-10");
    expect(signed.confidence).toBe("HIGH");
    expect(signed.page).toBe(1);
    expect(signed.warnings).not.toContain("day_month_order_assumed_dd_mm");

    const effective = field(fields, "effectiveDate")!;
    expect(effective.normalizedValue).toBe("2025-11-10");
    expect(effective.confidence).toBe("HIGH");
    expect(effective.warnings).not.toContain("day_month_order_assumed_dd_mm");

    const termination = field(fields, "terminationDate")!;
    expect(termination.normalizedValue).toBe("2026-11-09");
    expect(termination.confidence).toBe("HIGH");
    expect(termination.page).toBe(4);
    expect(termination.warnings).not.toContain("day_month_order_assumed_dd_mm");
  });

  it("prefers the defined 'Notice Period' sentence over an unrelated defect-notice mention on the same page", () => {
    const notice = field(fields, "noticeTerms")!;
    expect(notice.normalizedValue).toContain("20 (twenty) days");
    expect(notice.normalizedValue).toContain("Notice Period");
    expect(notice.normalizedValue).not.toContain("3 (Three) days");
    expect(notice.normalizedValue).not.toContain("receipt of the notice");
    expect(notice.confidence).toBe("LOW"); // sentence-level, no "Notice Period" heading
  });

  it("has no renewal or termination clause text (none is headed that way in this contract)", () => {
    expect(field(fields, "renewalTerms")).toBeUndefined();
    expect(field(fields, "terminationTerms")).toBeUndefined();
  });

  it("reads currency and a MONTHLY payment cycle attached to the Fee (not the content cadence)", () => {
    expect(field(fields, "currency")).toMatchObject({ normalizedValue: "INR", page: 3 });
    expect(field(fields, "paymentCycle")).toMatchObject({ normalizedValue: "MONTHLY", page: 3 });
  });

  it("reads the lower-limit Fee as the fixed component, warning that the upper limit is subject to approval", () => {
    const fixed = field(fields, "fixedComponent")!;
    expect(fixed.normalizedValue).toEqual({ applicable: true, amountMinor: TWO_PARTY_FIXED_AMOUNT_MINOR });
    expect(fixed.confidence).toBe("HIGH");
    expect(fixed.warnings).toContain("lower_limit_fee");
  });

  it("reads the monthly required count and keeps the free-form unit unmapped", () => {
    const count = field(fields, "monthlyRequiredQualifyingContentCount")!;
    expect(count.normalizedValue).toBe(TWO_PARTY_QUALIFYING_COUNT);
    expect(count.confidence).toBe("HIGH");
    expect(count.page).toBe(2);

    const unit = field(fields, "qualifyingUnit")!;
    expect(unit.normalizedValue).toBe(TWO_PARTY_QUALIFYING_UNIT);
    expect(unit.warnings).toContain("unit_requires_mapping_to_supported_qualifying_unit");
  });

  it("has no account transfer fee or advance payment (none is mentioned)", () => {
    expect(field(fields, "accountTransferFee")).toBeUndefined();
    expect(field(fields, "advancePayment")).toBeUndefined();
  });

  it("reads invoiceRequired from 'contingent upon the submission of a valid taxable invoice'", () => {
    expect(field(fields, "invoiceRequired")).toMatchObject({ normalizedValue: true, page: 3 });
  });

  it("reads the ordinal-day payment due terms exactly", () => {
    const due = field(fields, "paymentDueTerms")!;
    expect(due.normalizedValue).toBe("on or before the 12th (twelfth) working day of every calendar month");
    expect(due.page).toBe(3);
  });

  it("reads ONLY clause 2.1's body: no leading number/heading, and stops before 2.2", () => {
    const services = field(fields, "servicesMandated")!;
    expect(services.normalizedValue).not.toMatch(/^2\.1\.|Social Media Management:/);
    expect(services.normalizedValue).not.toContain("Timelines");
    expect(services.normalizedValue).not.toContain("2.2.");
    expect(services.normalizedValue).toContain("a minimum of 15 (fifteen) short-format Audio Visual Content");
    expect(services.normalizedValue).toContain("on a monthly basis");
    expect(services.page).toBe(2);
  });

  it("proposes NO applicable incentive (LOW, suggestion only) since the whole document names none", () => {
    const incentive = field(fields, "incentive")!;
    expect(incentive.normalizedValue).toEqual({ applicable: false, slabs: [] });
    expect(incentive.confidence).toBe("LOW");
    expect(incentive.warnings).toContain("no_incentive_language_found");
  });

  it("has no LFC/SFC split or performance targets (none is mentioned)", () => {
    expect(field(fields, "lfcSfc")).toBeUndefined();
    expect(field(fields, "performanceTargets")).toBeUndefined();
  });

  it("classifies as EXTRACTED with no document-level warnings", () => {
    expect(result.warnings).toEqual([]);
    const okPdf = { ok: true as const, pages: TWO_PARTY_AGREEMENT_TEXT_PAGES, pageCount: TWO_PARTY_AGREEMENT_TEXT_PAGES.length, totalChars: 1, truncated: { chars: false } };
    expect(classifyExtraction(okPdf, fields, result.warnings).status).toBe("EXTRACTED");
  });

  it("the embedded prompt-injection line changes nothing: no status/type field, human confirmation always required", () => {
    const keys = fields.map((f) => f.fieldKey as string);
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("agreementType");
    for (const f of fields) expect(f.requiresHumanConfirmation).toBe(true);
    expect(JSON.stringify(fields)).not.toMatch(/"requiresHumanConfirmation":false/);
  });

  it("splitRestricted keeps every identity value out of the ordinary record", () => {
    const split = splitRestricted(fields);
    const ordinaryJson = JSON.stringify(split.ordinary);
    for (const secret of [TWO_PARTY_PAN, TWO_PARTY_AADHAAR, TWO_PARTY_ACCOUNT_NUMBER, TWO_PARTY_IFSC]) expect(ordinaryJson).not.toContain(secret);
  });
});

describe("two-party service agreement: full pipeline over real PDF bytes", () => {
  it("makeTextPdf -> extractPdfText -> extractAgreementFields -> classifyExtraction -> splitRestricted", async () => {
    const pdf = makeTextPdf(TWO_PARTY_AGREEMENT_PAGES);
    const text = await extractPdfText(pdf);
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    const extraction = extractAgreementFields(text.pages);
    const classification = classifyExtraction(text, extraction.fields, extraction.warnings);
    expect(classification.status).toBe("EXTRACTED");

    const byKey = new Map(extraction.fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("counterpartyName")).toMatchObject({ normalizedValue: "Asha Verma", page: 1 });
    expect(byKey.get("effectiveDate")).toMatchObject({ normalizedValue: "2025-11-10", page: 1 });
    expect(byKey.get("fixedComponent")).toMatchObject({ normalizedValue: { applicable: true, amountMinor: TWO_PARTY_FIXED_AMOUNT_MINOR } });

    const split = splitRestricted(extraction.fields);
    const ordinaryJson = JSON.stringify(split.ordinary);
    for (const secret of [TWO_PARTY_PAN, TWO_PARTY_AADHAAR, TWO_PARTY_ACCOUNT_NUMBER, TWO_PARTY_IFSC]) expect(ordinaryJson).not.toContain(secret);
    const identity = new Map(split.restricted.identityValues.map((entry) => [entry.fieldKey, entry.normalizedValue]));
    expect(identity.get("panNumber")).toBe(TWO_PARTY_PAN);
    expect(identity.get("aadhaarNumber")).toBe(TWO_PARTY_AADHAAR);
  });
});

describe("date-words cross-check (dateFromParenthetical / parseDateWords, via labeledFinder's context option)", () => {
  function run(...lines: string[]) {
    return extractAgreementFields([lines.join("\n")]).fields;
  }

  it("raises confidence to HIGH and drops the ambiguity warning when the words agree (same-line, via `context`)", () => {
    const r = run("Effective Date: 10.11.2025 (Tenth November, Two Thousand Twenty Five)");
    const effective = field(r, "effectiveDate")!;
    expect(effective.normalizedValue).toBe("2025-11-10");
    expect(effective.confidence).toBe("HIGH");
    expect(effective.warnings).not.toContain("day_month_order_assumed_dd_mm");
  });

  it("keeps MEDIUM and warns when the words DISAGREE with the numeric date", () => {
    const r = run("Effective Date: 10.11.2025 (Twentieth November, Two Thousand Twenty Five)");
    const effective = field(r, "effectiveDate")!;
    expect(effective.normalizedValue).toBe("2025-11-10"); // the numeric reading still stands
    expect(effective.confidence).toBe("MEDIUM");
    expect(effective.warnings).toContain("date_words_mismatch");
  });

  it("month-first wording is also understood ('September Tenth, Two Thousand Twenty Six')", () => {
    const r = run("Effective Date: 10.09.2026 (September Tenth, Two Thousand Twenty Six)");
    const effective = field(r, "effectiveDate")!;
    expect(effective.normalizedValue).toBe("2026-09-10");
    expect(effective.confidence).toBe("HIGH");
  });
});
