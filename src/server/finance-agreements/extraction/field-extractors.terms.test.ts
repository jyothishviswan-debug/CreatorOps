import { describe, expect, it } from "vitest";

import { extractAgreementFields } from "./field-extractors";
import type { ExtractedFieldKey, ExtractedFieldProposal } from "./extraction-types";

function run(...pages: string[][]) {
  return extractAgreementFields(pages.map((lines) => lines.join("\n")));
}
function field<K extends ExtractedFieldKey>(result: ReturnType<typeof run>, key: K): Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined {
  return result.fields.find((f) => f.fieldKey === key) as Extract<ExtractedFieldProposal, { fieldKey: K }> | undefined;
}

describe("agreement number, page link and name", () => {
  it("reads a label-anchored agreement number that carries a digit", () => {
    expect(field(run(["Agreement Reference No: AGR-2025-001."]), "agreementNumber")).toMatchObject({ normalizedValue: "AGR-2025-001", confidence: "HIGH" });
    expect(field(run(["Contract No. CT/09/2025"]), "agreementNumber")?.normalizedValue).toBe("CT/09/2025");
    expect(field(run(["Agreement No: to be assigned"]), "agreementNumber")).toBeUndefined();
    expect(field(run(["Serial AGR-2025-001 somewhere"]), "agreementNumber")).toBeUndefined();
  });

  it("normalizes platform page links (scheme, www, query, trailing slash) and ignores non-platform URLs", () => {
    expect(field(run(["Page Link: http://www.instagram.com/some.page/?utm_source=x"]), "collaboratorPageLink")?.normalizedValue).toBe("https://instagram.com/some.page");
    expect(field(run(["YouTube Channel: youtube.com/@creatorname"]), "collaboratorPageLink")?.normalizedValue).toBe("https://youtube.com/@creatorname");
    expect(field(run(["Our website is https://www.example.com/about"]), "collaboratorPageLink")).toBeUndefined();
    expect(field(run(["Follow https://instagram.com/lone.page for updates"]), "collaboratorPageLink")).toMatchObject({ confidence: "LOW" });
  });

  it("reads a page name only from an explicit page/channel name label", () => {
    expect(field(run(["Channel Name: The Sample Show"]), "collaboratorPageName")?.normalizedValue).toBe("The Sample Show");
    expect(field(run(["Name: The Sample Show"]), "collaboratorPageName")).toBeUndefined();
  });
});

describe("date rules", () => {
  it("anchors dates on labels and phrases, never on stray dates", () => {
    expect(field(run(["This Agreement is made on 12 January 2025 between"]), "signedDate")).toMatchObject({ normalizedValue: "2025-01-12", confidence: "HIGH" });
    expect(field(run(["Date of Agreement: 12/01/2025"]), "signedDate")).toMatchObject({ normalizedValue: "2025-01-12", confidence: "MEDIUM" });
    expect(field(run(["Commencement Date: 1st April 2025"]), "effectiveDate")?.normalizedValue).toBe("2025-04-01");
    expect(field(run(["with effect from 1 April 2025"]), "effectiveDate")?.normalizedValue).toBe("2025-04-01");
    expect(field(run(["Valid till 31-03-2026"]), "terminationDate")?.normalizedValue).toBe("2026-03-31");
    expect(field(run(["Invoice raised on 12 January 2025"]), "signedDate")).toBeUndefined();
    expect(field(run(["Effective Date: to be decided"]), "effectiveDate")).toBeUndefined();
  });

  it("refuses impossible dates and flags an end date before the effective date", () => {
    expect(field(run(["Effective Date: 31/02/2025"]), "effectiveDate")).toBeUndefined();
    const r = run(["Effective Date: 1 April 2026", "End Date: 31 March 2025"]);
    expect(field(r, "effectiveDate")!.warnings).toContain("end_before_effective");
    expect(field(r, "terminationDate")!.warnings).toContain("end_before_effective");
  });
});

describe("clause rules", () => {
  it("reads heading-anchored clauses across lines, up to the next numbered heading", () => {
    const r = run(["6. Renewal", "The term renews automatically for 12 months", "unless either party objects in writing.", "7. Confidentiality", "Both parties keep matters private."]);
    expect(field(r, "renewalTerms")).toMatchObject({ normalizedValue: "The term renews automatically for 12 months unless either party objects in writing.", confidence: "MEDIUM" });
  });

  it("reads inline 'Heading: text' clauses and a Notice Period heading", () => {
    const r = run(["Notice Period: Either party must give 45 days prior written notice."]);
    expect(field(r, "noticeTerms")).toMatchObject({ normalizedValue: "Either party must give 45 days prior written notice.", confidence: "MEDIUM" });
    expect(field(run(["Termination: The company may end this Agreement for repeated breach."]), "terminationTerms")?.normalizedValue).toBe("The company may end this Agreement for repeated breach.");
  });

  it("does not take a sentence that merely starts with a heading word as a heading", () => {
    expect(field(run(["Termination of this Agreement shall not affect accrued rights."]), "terminationTerms")).toBeUndefined();
  });

  it("skips table-of-contents dot leaders and prefers the longest body when a heading repeats", () => {
    const r = run(["CONTENTS", "Termination .......... 5"], ["12. Termination", "Either party may terminate for material breach after a 15 day cure period."]);
    const clause = field(r, "terminationTerms")!;
    expect(clause.normalizedValue).toBe("Either party may terminate for material breach after a 15 day cure period.");
    expect(clause.page).toBe(2);
    expect(clause.confidence).toBe("MEDIUM");
  });

  it("flags a clause that runs to the end of its page and bounds clause length", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} of the long clause text.`);
    const r = run(["8. Scope of Services", ...long]);
    const clause = field(r, "servicesMandated")!;
    expect(clause.normalizedValue.length).toBeLessThanOrEqual(2000);
    expect(clause.warnings).toContain("clause_truncated");
    const spill = field(run(["8. Scope of Services", "Publish content weekly."], ["as agreed in the brief."]), "servicesMandated")!;
    expect(spill.warnings).toContain("clause_may_continue_on_next_page");
  });
});

describe("commercial rules", () => {
  it("detects INR by label or by an amount marker, and is careful with other currencies", () => {
    expect(field(run(["Currency: Indian Rupees"]), "currency")).toMatchObject({ normalizedValue: "INR", confidence: "HIGH" });
    expect(field(run(["The fee is Rs. 5,000 per month"]), "currency")).toMatchObject({ normalizedValue: "INR", confidence: "MEDIUM" });
    expect(field(run(["The fee is USD 500 per month"]), "currency")).toBeUndefined();
    expect(run(["The fee is USD 500 per month"]).warnings).toContainEqual({ code: "non_inr_currency_detected", fieldKey: "currency" });
    expect(field(run(["Fee Rs. 5,000 or $60"]), "currency")).toMatchObject({ confidence: "LOW" });
    expect(field(run(["There are Rs items"]), "currency")).toBeUndefined();
  });

  it("maps payment cycles, marking mapped-to-OTHER and multi-cycle values", () => {
    expect(field(run(["Payment Cycle: Fortnightly"]), "paymentCycle")?.normalizedValue).toBe("FORTNIGHTLY");
    expect(field(run(["Payout Frequency: Quarterly"]), "paymentCycle")?.normalizedValue).toBe("QUARTERLY");
    expect(field(run(["Payment Cycle: Half-yearly"]), "paymentCycle")).toMatchObject({ normalizedValue: "OTHER" });
    expect(field(run(["Payment Cycle: Monthly or quarterly"]), "paymentCycle")).toMatchObject({ confidence: "LOW" });
    expect(field(run(["The fee shall be paid monthly in arrears."]), "paymentCycle")).toMatchObject({ normalizedValue: "MONTHLY", confidence: "MEDIUM" });
    expect(field(run(["Payment Cycle: as discussed"]), "paymentCycle")).toBeUndefined();
  });

  it("parses fixed amounts to integer minor units (Indian grouping and lakh) and handles 'not applicable'", () => {
    expect(field(run(["Fixed Fee: Rs. 2,50,000/-"]), "fixedComponent")?.normalizedValue).toEqual({ applicable: true, amountMinor: 25_000_000 });
    expect(field(run(["Monthly Retainer: 2.5 lakh"]), "fixedComponent")?.normalizedValue).toEqual({ applicable: true, amountMinor: 25_000_000 });
    expect(field(run(["Fixed Amount: INR 12,500.50"]), "fixedComponent")?.normalizedValue).toEqual({ applicable: true, amountMinor: 1_250_050 });
    expect(field(run(["Fixed Fee: Nil"]), "fixedComponent")?.normalizedValue).toEqual({ applicable: false, amountMinor: null });
    expect(field(run(["Fixed Fee: as agreed"]), "fixedComponent")).toBeUndefined();
    expect(field(run(["Fixed Fee: 25000"]), "fixedComponent")).toBeUndefined(); // no money marker
    expect(field(run(["Fixed Fee: Rs. 25,00,0"]), "fixedComponent")).toBeUndefined(); // malformed grouping
    expect(field(run(["Fixed Fee: Rs. 0"]), "fixedComponent")).toMatchObject({ confidence: "LOW" });
  });

  it("maps the old 'Fixed deliverable units' label to the required content count and unit", () => {
    const r = run(["Fixed deliverable units: 8 Reels"]);
    expect(field(r, "monthlyRequiredQualifyingContentCount")?.normalizedValue).toBe(8);
    expect(field(r, "qualifyingUnit")?.normalizedValue).toBe("reel");
    expect(field(r, "qualifyingUnit")!.warnings).toContain("unit_requires_mapping_to_supported_qualifying_unit");
    const noUnit = run(["Monthly Deliverables: 10"]);
    expect(field(noUnit, "monthlyRequiredQualifyingContentCount")).toMatchObject({ normalizedValue: 10, confidence: "MEDIUM" });
    expect(field(noUnit, "qualifyingUnit")).toBeUndefined();
    expect(field(run(["Monthly Deliverables: as per brief"]), "monthlyRequiredQualifyingContentCount")).toBeUndefined();
    expect(field(run(["The Collaborator shall deliver a minimum of 12 posts each month."]), "monthlyRequiredQualifyingContentCount")).toMatchObject({ normalizedValue: 12, confidence: "MEDIUM" });
  });

  it("reads transfer fee and advance payment, including explicit 'no advance'", () => {
    expect(field(run(["Page Transfer Fee: Rs. 15,000"]), "accountTransferFee")?.normalizedValue).toEqual({ applicable: true, amountMinor: 1_500_000, details: null });
    expect(field(run(["Account Transfer Charges: Not applicable"]), "accountTransferFee")?.normalizedValue).toEqual({ applicable: false, amountMinor: null, details: null });
    expect(field(run(["Advance Payment: Rs. 10,000 on signing"]), "advancePayment")?.normalizedValue).toEqual({ applicable: true, details: null, amountMinor: 1_000_000 });
    expect(field(run(["Advance: No"]), "advancePayment")?.normalizedValue).toEqual({ applicable: false, details: null, amountMinor: null });
    expect(field(run(["Advance Payment: 50% upfront"]), "advancePayment")).toMatchObject({ normalizedValue: { applicable: true, details: "50% upfront", amountMinor: null }, confidence: "LOW" });
    expect(field(run(["Advance Notice: 30 days"]), "advancePayment")).toBeUndefined();
  });

  it("reads invoice-required by label or phrase and omits conflicting statements", () => {
    expect(field(run(["Invoice Required: No"]), "invoiceRequired")).toMatchObject({ normalizedValue: false, confidence: "HIGH" });
    expect(field(run(["The Collaborator shall raise an invoice every month."]), "invoiceRequired")).toMatchObject({ normalizedValue: true, confidence: "MEDIUM" });
    const conflict = run(["The Collaborator shall submit an invoice monthly.", "No invoice is needed for the advance."]);
    expect(field(conflict, "invoiceRequired")).toBeUndefined();
    expect(conflict.warnings).toContainEqual({ code: "conflicting_invoice_statements", fieldKey: "invoiceRequired", page: 1 });
  });

  it("separates invoice-submission windows from payment windows and never merges them", () => {
    const r = run(["The Collaborator shall submit the invoice within 5 days of month end.", "Payment shall be made within 30 days of receipt of invoice."]);
    expect(field(r, "invoiceDueTerms")?.normalizedValue).toBe("The Collaborator shall submit the invoice within 5 days of month end.");
    expect(field(r, "paymentDueTerms")?.normalizedValue).toBe("Payment shall be made within 30 days of receipt of invoice.");
    expect(field(run(["Payment Terms: Net 45"]), "paymentDueTerms")).toMatchObject({ normalizedValue: "Net 45", confidence: "HIGH" });
    expect(field(run(["Payment Terms: as per agreement"]), "paymentDueTerms")).toBeUndefined();
    const both = run(["Submit the invoice and receive payment within 10 days."]);
    expect(field(both, "invoiceDueTerms")).toBeUndefined();
    expect(field(both, "paymentDueTerms")).toBeUndefined();
    expect(both.warnings.map((w) => w.code)).toContain("due_terms_sentence_mentions_invoice_and_payment");
  });
});

describe("incentive, LFC/SFC and targets", () => {
  it("reads explicit slabs, an explicit 'nil', and warns instead of guessing an unreadable incentive", () => {
    expect(field(run(["Incentive: Nil"]), "incentive")?.normalizedValue).toEqual({ applicable: false, slabs: [] });
    const r = run(["Incentive slabs:", "• 1 lakh - 2 lakh views: Rs. 3,000", "• Above 2 lakh views: Rs. 6,000"]);
    expect(field(r, "incentive")?.normalizedValue.slabs.map((s) => [s.lowerBound, s.upperBound, s.amountMinor])).toEqual([
      [100_000, 200_000, 300_000],
      [200_000, null, 600_000],
    ]);
    const unreadable = run(["Incentive: Collaborator earns a share of ad revenue as discussed."]);
    expect(field(unreadable, "incentive")).toBeUndefined();
    expect(unreadable.warnings).toContainEqual({ code: "incentive_slabs_not_parsed", fieldKey: "incentive", page: 1 });
    // A slab whose bounds are inverted is not a slab.
    expect(field(run(["Incentive:", "50,000 to 10,000 views: Rs. 2,000"]), "incentive")).toBeUndefined();
    // A slab of an unrecognised metric is skipped, not guessed.
    expect(field(run(["Incentive:", "10 to 20 widgets: Rs. 2,000"]), "incentive")).toBeUndefined();
  });

  it("a bare, unlabeled mention of 'incentive' elsewhere (e.g. inside a Bank Details clause) is NEVER read as a confirmed absence - it warns, never silently vanishes and never claims 'not applicable'", () => {
    const r = run(["Bank Details: The Service Provider will get Fee and Incentives credited as per clause 5.1 of the agreement.", "Account No.: 12345"]);
    expect(field(r, "incentive")).toBeUndefined();
    expect(r.warnings).toContainEqual({ code: "incentive_mentioned_but_no_clause_found", fieldKey: "incentive", page: 1 });
  });

  it("reads LFC/SFC ONLY from an explicit format list, dropping formats claimed by both classes", () => {
    expect(field(run(["LFC: YouTube videos"]), "lfcSfc")?.normalizedValue).toEqual({ byFormat: { "youtube videos": "LFC" } });
    expect(field(run(["Short form content (SFC) includes reels and shorts."]), "lfcSfc")?.normalizedValue).toEqual({ byFormat: { reels: "SFC", shorts: "SFC" } });
    expect(field(run(["Deliverables are LFC and SFC content as briefed."]), "lfcSfc")).toBeUndefined();
    const conflict = run(["LFC: Podcast, Reels", "SFC: Reels"]);
    expect(field(conflict, "lfcSfc")?.normalizedValue).toEqual({ byFormat: { podcast: "LFC" } });
    expect(field(conflict, "lfcSfc")!.warnings).toContain("lfc_sfc_format_conflict_dropped");
    expect(field(run(["LFC: "]), "lfcSfc")).toBeUndefined();
  });

  it("without an LFC/SFC acronym, falls back to a quantity-qualified long/short-format split (never a bare mention, never a one-sided one)", () => {
    const both = run(["The Monthly Posts shall consist of a minimum of 85 (eighty five) long format Audio Visual Content", "and a minimum of 20 (twenty) short format Audio Visual Content."]);
    expect(field(both, "lfcSfc")?.normalizedValue).toEqual({ byFormat: { "long format audio visual content": "LFC", "short format audio visual content": "SFC" } });
    expect(field(both, "lfcSfc")!.warnings).toContain("inferred_from_long_short_format_wording");
    // A definitional list naming both words in passing, with NO quantity before either, is not a classification.
    const definitionOnly = run(["Audio Visual Content includes reaction videos, long-format videos, short-format videos, drama content and podcasts."]);
    expect(field(definitionOnly, "lfcSfc")).toBeUndefined();
    // Only one side named (even with a quantity) is not a split either.
    expect(field(run(["A minimum of 85 long format Audio Visual Content is required monthly."]), "lfcSfc")).toBeUndefined();
  });

  it("extracts every performance target as warning-only (affectsPayment:false), with metric ids and units", () => {
    const r = run([
      "Performance targets: minimum 50k views per reel.",
      "KPI: 10,000 new followers each month.",
      "Target engagement rate of at least 3.5%.",
      "Target: 2 lakh reach.",
      "Goal: 500 likes per post and 40 comments per post.",
    ]);
    const targets = field(r, "performanceTargets")!.normalizedValue;
    expect(targets.every((t) => t.affectsPayment === false && t.comparison === "at_least")).toBe(true);
    expect(targets.map((t) => [t.metricId, t.targetValue, t.unit])).toEqual(
      expect.arrayContaining([
        ["views", 50_000, "views per reel"],
        ["followerGrowth", 10_000, "followers per month"],
        ["engagement", 3.5, "percent"],
        ["reach", 200_000, "reach"],
        ["likes", 500, "likes per post"],
        ["comments", 40, "comments per post"],
      ]),
    );
    expect(new Set(targets.map((t) => t.targetRef)).size).toBe(targets.length);
  });

  it("does not turn upper bounds, payment wording or unanchored numbers into targets", () => {
    expect(field(run(["Target: at most 10,000 views."]), "performanceTargets")).toBeUndefined();
    expect(field(run(["Target: 10,000 views earns Rs. 2,000."]), "performanceTargets")).toBeUndefined();
    expect(field(run(["The reel got 10,000 views last month."]), "performanceTargets")).toBeUndefined();
    expect(field(run(["Minimum 12 reels per month"]), "performanceTargets")).toBeUndefined();
  });

  it("reads targets laid out as a TABLE (metric name and its 'minimum of N' value on different lines, under bare row numbers a real PDF flattens from a table)", () => {
    const r = run([
      "3.6. Growth Targets: The Service Provider shall achieve the growth targets as mentioned below within every 30th day.",
      "The growth targets are as follows-",
      "Sl. No. Engagement Metrics Targets",
      "1. Subscribers/followers on the Designated Social Media Channel",
      "A minimum of 5,000 (five thousand), every 30th (thirtieth) days, starting from the Effective Date of the Agreement.",
      "2. Viewership across all the Monthly Posts",
      "A minimum of 10,00,000 (ten lakh), every 30th (thirtieth) days, starting from the Effective Date of the Agreement.",
      "3.7. Compliance with Third-Party Content Rights: The Service Provider affirms...",
    ]);
    const targets = field(r, "performanceTargets")!.normalizedValue;
    // The clause's own cadence number ("30th") is never mistaken for a target - only the quantity explicitly led by "minimum of".
    expect(targets.map((t) => [t.metricId, t.targetValue])).toEqual(
      expect.arrayContaining([
        ["followerGrowth", 5_000],
        ["views", 1_000_000], // Indian digit grouping: 10,00,000
      ]),
    );
    expect(targets.every((t) => t.affectsPayment === false)).toBe(true);
    // The table's bare "1."/"2." row numbers never get mistaken for the next real clause and cut the table short;
    // the real sibling clause "3.7" afterwards is untouched by this (its own text is not swept into the targets).
    expect(field(r, "servicesMandated")).toBeUndefined();
  });

  it("the table reader needs BOTH a growth/performance/engagement-targets heading AND an explicit 'minimum of' qualifier - neither alone is enough", () => {
    // A targets-style heading, but the row states a bare number with no "minimum of" qualifier.
    expect(field(run(["3.6. Growth Targets:", "Subscribers on the Designated Social Media Channel: 5,000 within 30 days."]), "performanceTargets")).toBeUndefined();
    // An explicit "minimum of" quantity, but no targets-style heading anywhere (just a Fee clause).
    expect(field(run(["5.1. Fee: The Client shall pay a minimum of 5,000 (five thousand) INR as the monthly Fee."]), "performanceTargets")).toBeUndefined();
  });

  it("caps targets at the policy bound and says so", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Target: ${1000 * (i + 1)} views.`);
    const r = field(run(lines), "performanceTargets")!;
    expect(r.normalizedValue).toHaveLength(12);
    expect(r.warnings).toContain("targets_truncated");
  });
});

describe("page numbers and multi-page documents", () => {
  it("reports the 1-based page each value came from", () => {
    const r = run(["Cover page with nothing useful"], ["Some preamble text here"], ["PAN: ABCPE1234F", "Currency: INR"], ["Payment Cycle: Weekly"]);
    expect(field(r, "panNumber")!.page).toBe(3);
    expect(field(r, "currency")!.page).toBe(3);
    expect(field(r, "paymentCycle")!.page).toBe(4);
  });

  it("keeps the snippet within 300 chars even for a very long line", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(300);
    const r = run([`${filler} PAN: ABCPE1234F ${filler}`]);
    expect(field(r, "panNumber")!.rawSnippet.length).toBeLessThanOrEqual(300);
    expect(field(r, "panNumber")!.rawSnippet).toContain("ABCPE1234F");
  });
});
