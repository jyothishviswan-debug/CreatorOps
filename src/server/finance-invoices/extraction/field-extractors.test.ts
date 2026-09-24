import { describe, expect, it } from "vitest";

import { extractInvoiceFields } from "./field-extractors";

function fields(page: string) {
  return extractInvoiceFields([page]);
}

describe("extractInvoiceFields", () => {
  it("extracts invoice number, dates, subtotal, tax rate, tax amount and declared total from a clean layout", () => {
    const page = [
      "Invoice Number: INV-2026-014",
      "Invoice Date: 15 March 2026",
      "Due Date: 30 March 2026",
      "From: Acme Creator Studio Pvt Ltd",
      "Sub Total: INR 41,000",
      "GST @ 18%",
      "GST Amount: INR 7,380",
      "Total Due: INR 48,380",
    ].join("\n");
    const result = fields(page);
    const byKey = Object.fromEntries(result.fields.map((f) => [f.fieldKey, f]));

    expect(byKey.externalInvoiceNumber?.value).toBe("INV-2026-014");
    expect(byKey.invoiceDate?.value).toBe("2026-03-15");
    expect(byKey.dueDate?.value).toBe("2026-03-30");
    expect(byKey.supplierName?.value).toBe("Acme Creator Studio Pvt Ltd");
    expect(byKey.subtotalMinor?.value).toBe(4_100_000);
    expect(byKey.taxRateBps?.value).toBe(1800);
    expect(byKey.taxAmountMinor?.value).toBe(738_000);
    expect(byKey.declaredTotalMinor?.value).toBe(4_838_000);
    expect(byKey.currency?.value).toBe("INR");

    // Every proposal is unconfirmed, no matter how confident.
    for (const proposal of result.fields) {
      expect(proposal.requiresHumanConfirmation).toBe(true);
    }
  });

  it("is HIGH confidence for a same-line label/value pair", () => {
    const result = fields("Total: INR 5,000");
    expect(result.fields.find((f) => f.fieldKey === "declaredTotalMinor")?.confidence).toBe("HIGH");
  });

  it("proposes nothing for a field whose label has no unambiguous value nearby - never a guess", () => {
    const result = fields("Total: to be confirmed later");
    expect(result.fields.some((f) => f.fieldKey === "declaredTotalMinor")).toBe(false);
  });

  it("never proposes a bare number with no currency marker as an amount", () => {
    const result = fields("Total: 5000");
    expect(result.fields.some((f) => f.fieldKey === "declaredTotalMinor")).toBe(false);
  });

  it("withholds the GSTIN value (restricted) while still flagging its presence/location", () => {
    const result = fields("Supplier GSTIN: 29ABCDE1234F1Z5");
    const proposal = result.fields.find((f) => f.fieldKey === "gstin")!;
    expect(proposal.restricted).toBe(true);
    expect(proposal.value).toBeNull();
    expect(proposal.rawSnippet).toBeNull();
    expect(proposal.page).toBe(1);
  });

  it("returns an empty result for a page with no recognizable Invoice fields at all", () => {
    const result = fields("This page has no invoice-shaped content whatsoever.");
    expect(result.fields).toEqual([]);
  });

  it("only ever keeps the FIRST match per field key, even across multiple pages", () => {
    const result = extractInvoiceFields(["Total: INR 1,000", "Total: INR 9,999"]);
    const totals = result.fields.filter((f) => f.fieldKey === "declaredTotalMinor");
    expect(totals).toHaveLength(1);
    expect(totals[0]!.value).toBe(100_000);
    expect(totals[0]!.page).toBe(1);
  });

  it("finds an amount glued directly BEFORE its label with no separator (a real PDF-export layout)", () => {
    // Confirmed real-world pattern from a user-uploaded invoice: the amount and its label render
    // with zero whitespace between them once the PDF's text layer is flattened.
    const result = fields("₹27000Sub Total");
    const proposal = result.fields.find((f) => f.fieldKey === "subtotalMinor");
    expect(proposal?.value).toBe(2_700_000);
    expect(proposal?.confidence).toBe("HIGH");
    expect(proposal?.warnings).toContain("amount_found_before_label");
  });

  it("does not misattribute an unrelated amount earlier on the page to a later label", () => {
    // "INR 500" here is a separate line item, not glued onto "Total" - the gap is too wide to
    // trust, so this must not propose 500 as the declared total.
    const result = fields("Line item: INR 500\n\nTotal: to be confirmed later");
    expect(result.fields.some((f) => f.fieldKey === "declaredTotalMinor")).toBe(false);
  });
});
