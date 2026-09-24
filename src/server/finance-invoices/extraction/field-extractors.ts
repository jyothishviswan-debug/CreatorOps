// Step 15C section 19/24: PURE, label-anchored Invoice field extraction over already-normalized
// page text. Reuses Agreement extraction's domain-agnostic value parsers (findAmounts, findDates,
// parseAmountToMinor) directly rather than re-implementing money/date parsing - see this module's
// own header in extraction-types.ts for why the two domains stay separate modules even while
// sharing these pure utilities.
//
// THE SAME DISCIPLINE AS EVERY OTHER EXTRACTOR IN THIS CODEBASE: a label found with no
// unambiguous value nearby proposes NOTHING for that field (never a guess, never an invented
// default) - the field is simply absent from the result, which the caller (and, later, a
// confirmation UI) treats as "not extracted", not as "confirmed absent".

import type { InvoiceExtractedFieldProposal, InvoiceExtractionConfidence, InvoiceFieldExtractionResult } from "./types";
import { findAmounts, findDates } from "./value-parsers";

const SNIPPET_RADIUS = 60;
const WINDOW_CHARS = 120;

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

// Finds the first occurrence of ANY label in `labels` (case-insensitive) on `text`, and returns
// the text window immediately after it (up to WINDOW_CHARS or the next blank line, whichever is
// shorter) plus the label's own match index (for the snippet and confidence check).
function windowAfterLabel(text: string, labels: RegExp): { window: string; labelStart: number; labelEnd: number; sameLineChars: number } | null {
  const match = labels.exec(text);
  if (!match) return null;
  const labelEnd = match.index + match[0].length;
  const restOfLine = text.slice(labelEnd, text.indexOf("\n", labelEnd) === -1 ? text.length : text.indexOf("\n", labelEnd));
  const window = text.slice(labelEnd, labelEnd + WINDOW_CHARS);
  return { window, labelStart: match.index, labelEnd, sameLineChars: restOfLine.length };
}

function amountField(
  fieldKey: InvoiceExtractedFieldProposal["fieldKey"],
  page: string,
  pageIndex: number,
  labelPattern: RegExp,
): InvoiceExtractedFieldProposal | null {
  const found = windowAfterLabel(page, labelPattern);
  if (!found) return null;
  const amounts = findAmounts(found.window);
  if (amounts.length > 0) {
    const amount = amounts[0]!;
    // HIGH when the amount sits within the label's own line (a clean "Label: 5,000" pattern);
    // MEDIUM when it was found further down the window (a label followed by a line break, still
    // unambiguous - only one amount was found in the whole window).
    const confidence: InvoiceExtractionConfidence = amount.index < found.sameLineChars + 5 ? "HIGH" : "MEDIUM";
    return {
      fieldKey,
      value: amount.amountMinor,
      rawSnippet: snippetAround(found.window, amount.index, amount.length),
      page: pageIndex + 1,
      confidence,
      warnings: [],
      requiresHumanConfirmation: true,
      restricted: false,
    };
  }

  // Fallback: some real invoice layouts place the amount immediately BEFORE its label with NO
  // separator at all (e.g. a PDF export that glues "₹27000" straight onto "Sub Total" once the
  // text layer is flattened). Only ever trusted when the amount is glued with ZERO characters of
  // gap - anything else (a space, a line break) means it's a different piece of text (a line item
  // a paragraph above, a rate) and must never be misattributed to this label.
  const beforeStart = Math.max(0, found.labelStart - WINDOW_CHARS);
  const beforeWindow = page.slice(beforeStart, found.labelStart);
  const beforeAmounts = findAmounts(beforeWindow);
  if (beforeAmounts.length === 0) return null;
  const closest = beforeAmounts[beforeAmounts.length - 1]!;
  if (closest.index + closest.length !== beforeWindow.length) return null;
  return {
    fieldKey,
    value: closest.amountMinor,
    rawSnippet: snippetAround(page, beforeStart + closest.index, closest.length),
    page: pageIndex + 1,
    confidence: "HIGH",
    warnings: ["amount_found_before_label"],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

function dateField(fieldKey: InvoiceExtractedFieldProposal["fieldKey"], page: string, pageIndex: number, labelPattern: RegExp): InvoiceExtractedFieldProposal | null {
  const found = windowAfterLabel(page, labelPattern);
  if (!found) return null;
  const dates = findDates(found.window);
  if (dates.length === 0) return null;
  const date = dates[0]!;
  const confidence: InvoiceExtractionConfidence = date.index < found.sameLineChars + 5 ? "HIGH" : "MEDIUM";
  return {
    fieldKey,
    value: date.iso,
    rawSnippet: snippetAround(found.window, date.index, date.length),
    page: pageIndex + 1,
    confidence: date.dayMonthOrderAssumed ? "MEDIUM" : confidence,
    warnings: date.dayMonthOrderAssumed ? ["date_day_month_order_assumed"] : [],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

// "Invoice No: INV-2026-014", "Invoice Number 2026/014", "Invoice #14" - a short token of
// digits/letters/hyphens/slashes right after the label, never a whole free-text line.
const INVOICE_NUMBER_LABEL = /invoice\s*(?:number|no\.?|#)\s*[:\-]?\s*/i;
function invoiceNumberField(page: string, pageIndex: number): InvoiceExtractedFieldProposal | null {
  const match = INVOICE_NUMBER_LABEL.exec(page);
  if (!match) return null;
  const rest = page.slice(match.index + match[0].length);
  const tokenMatch = /^([A-Za-z0-9][A-Za-z0-9/\-_.]{1,40})/.exec(rest);
  if (!tokenMatch) return null;
  const value = tokenMatch[1]!.replace(/[.,;]+$/, "");
  return {
    fieldKey: "externalInvoiceNumber",
    value,
    rawSnippet: snippetAround(page, match.index, match[0].length + value.length),
    page: pageIndex + 1,
    confidence: "HIGH",
    warnings: [],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

const SUPPLIER_LABEL = /(?:from|supplier|vendor|billed\s*by)\s*[:\-]\s*/i;
function supplierNameField(page: string, pageIndex: number): InvoiceExtractedFieldProposal | null {
  const match = SUPPLIER_LABEL.exec(page);
  if (!match) return null;
  const lineEnd = page.indexOf("\n", match.index);
  const line = page.slice(match.index + match[0].length, lineEnd === -1 ? undefined : lineEnd).trim();
  if (line.length === 0 || line.length > 200) return null;
  return {
    fieldKey: "supplierName",
    value: line,
    rawSnippet: snippetAround(page, match.index, match[0].length + line.length),
    page: pageIndex + 1,
    confidence: "MEDIUM",
    warnings: [],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

const CURRENCY_PATTERN = /\b(INR|USD|GBP|EUR|AED)\b|₹/;
function currencyField(page: string, pageIndex: number): InvoiceExtractedFieldProposal | null {
  const match = CURRENCY_PATTERN.exec(page);
  if (!match) return null;
  const code = match[1] ?? "INR"; // the rupee symbol implies INR
  return {
    fieldKey: "currency",
    value: code,
    rawSnippet: snippetAround(page, match.index, match[0].length),
    page: pageIndex + 1,
    confidence: "MEDIUM",
    warnings: [],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

// GST/tax rate stated as a percentage near a tax label - e.g. "GST @ 18%", "Tax (18%)".
const TAX_RATE_LABEL = /(gst|tax|vat)\D{0,20}?(\d{1,2}(?:\.\d{1,2})?)\s*%/i;
function taxRateField(page: string, pageIndex: number): InvoiceExtractedFieldProposal | null {
  const match = TAX_RATE_LABEL.exec(page);
  if (!match) return null;
  const percent = Number(match[2]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const rateBps = Math.round(percent * 100);
  return {
    fieldKey: "taxRateBps",
    value: rateBps,
    rawSnippet: snippetAround(page, match.index, match[0].length),
    page: pageIndex + 1,
    confidence: "MEDIUM",
    warnings: [],
    requiresHumanConfirmation: true,
    restricted: false,
  };
}

// GSTIN: a 15-character alphanumeric pattern (2 digits, 10 PAN-shaped, 1 entity code, 1 "Z", 1
// checksum). RESTRICTED - the value is withheld here (null); only its presence/location/warning is
// exposed, matching Agreement extraction's own identity-field handling. A future confirmation flow
// that genuinely needs the value reads it through the same restricted-access discipline as
// Agreement extraction (finance_contracts + payment_details/vendor_payment_details), never from an
// ordinary DTO.
const GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b/;
function gstinField(page: string, pageIndex: number): InvoiceExtractedFieldProposal | null {
  const match = GSTIN_PATTERN.exec(page);
  if (!match) return null;
  return {
    fieldKey: "gstin",
    value: null,
    rawSnippet: null,
    page: pageIndex + 1,
    confidence: "HIGH",
    warnings: [],
    requiresHumanConfirmation: true,
    restricted: true,
  };
}

export function extractInvoiceFields(pages: string[]): InvoiceFieldExtractionResult {
  const fields: InvoiceExtractedFieldProposal[] = [];
  const seen = new Set<string>();
  const push = (proposal: InvoiceExtractedFieldProposal | null) => {
    if (!proposal || seen.has(proposal.fieldKey)) return;
    seen.add(proposal.fieldKey);
    fields.push(proposal);
  };

  pages.forEach((page, pageIndex) => {
    push(invoiceNumberField(page, pageIndex));
    push(dateField("invoiceDate", page, pageIndex, /invoice\s*date\s*[:\-]?\s*/i));
    push(dateField("dueDate", page, pageIndex, /due\s*date\s*[:\-]?\s*/i));
    push(supplierNameField(page, pageIndex));
    push(currencyField(page, pageIndex));
    push(amountField("subtotalMinor", page, pageIndex, /sub\s*-?\s*total\s*[:\-]?\s*/i));
    push(taxRateField(page, pageIndex));
    push(amountField("taxAmountMinor", page, pageIndex, /(?:gst|tax)\s*amount\s*[:\-]?\s*/i));
    // Never matches inside "Sub Total"/"Sub-Total" - the negative lookbehind excludes exactly that prefix.
    push(amountField("declaredTotalMinor", page, pageIndex, /(?<!sub[\s-])(?:grand\s*)?total(?:\s*due)?\s*[:\-]?\s*/i));
    push(gstinField(page, pageIndex));
  });

  return { fields, warnings: [] };
}
