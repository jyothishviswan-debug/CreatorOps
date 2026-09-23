// Step 16B: display-only labels, tones, formatters and copy for the Finance Invoices UI. Nothing
// here changes a stored value. Pure and browser-safe. Invoices vocabulary only - a local copy of
// the small generic pieces (relative/absolute time), matching Payables' own "Finance never imports
// from another feature's format module" rule.
import { absoluteTime, relativeTime } from "@/features/administration/format";
import type { InvoiceCounterpartyType, InvoiceReconciliationCode, InvoiceReconciliationState, InvoiceStatus, InvoiceVersionChangeKind } from "@/server/finance-invoices/types";

export { absoluteTime, relativeTime };

export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";
export type ChipSpec = { label: string; tone: PillTone };

export const NO_VALUE_TEXT = "—";
export const AMOUNT_HIDDEN_TEXT = "Hidden";

// --- Lifecycle status -------------------------------------------------------------------------------------------------------------
export const INVOICE_STATUS_CHIPS: Record<InvoiceStatus, ChipSpec> = {
  DRAFT: { label: "Draft", tone: "gray" },
  SUBMITTED: { label: "Submitted", tone: "orange" },
  APPROVED: { label: "Approved", tone: "default" },
  REJECTED: { label: "Rejected", tone: "red" },
  VOID: { label: "Void", tone: "red" },
};
export function invoiceStatusChip(status: InvoiceStatus): ChipSpec {
  return INVOICE_STATUS_CHIPS[status];
}

// --- Reconciliation ---------------------------------------------------------------------------------------------------------------
export const RECONCILIATION_CHIPS: Record<InvoiceReconciliationState, ChipSpec> = {
  MATCH: { label: "Match", tone: "default" },
  MISMATCH: { label: "Mismatch", tone: "orange" },
  MISSING_IN_INVOICE: { label: "Missing information", tone: "gray" },
  MISSING_IN_PAYABLE: { label: "Missing information", tone: "gray" },
  REVIEW_REQUIRED: { label: "Review required", tone: "orange" },
  BLOCKED: { label: "Blocked", tone: "red" },
};
export function reconciliationChip(state: InvoiceReconciliationState): ChipSpec {
  return RECONCILIATION_CHIPS[state];
}

export const RECONCILIATION_RESULT_LABELS: Record<InvoiceReconciliationCode | "OK", string> = {
  OK: "Match",
  CURRENCY_MISMATCH: "Mismatch",
  TOTAL_AMOUNT_MISMATCH: "Mismatch",
  COUNTERPARTY_MISMATCH: "Mismatch",
  COMMERCIAL_PERIOD_MISMATCH: "Mismatch",
  PAYABLE_VERSION_STALE: "Review required",
  DUPLICATE_INVOICE_NUMBER: "Mismatch",
  MISSING_INVOICE_DOCUMENT: "Missing in Invoice",
  MISSING_INVOICE_TOTAL: "Missing in Invoice",
  MISSING_PAYABLE_TOTAL: "Missing in Payable",
  ARITHMETIC_INCONSISTENT: "Review required",
};

// --- Counterparty -------------------------------------------------------------------------------------------------------------------
export const COUNTERPARTY_TYPE_LABELS: Record<InvoiceCounterpartyType, string> = { PARTNER: "Partner", VENDOR: "Vendor" };
export function counterpartyTypeLabel(type: InvoiceCounterpartyType): string {
  return COUNTERPARTY_TYPE_LABELS[type];
}
export function counterpartyTypeTone(type: InvoiceCounterpartyType): PillTone {
  return type === "PARTNER" ? "blue" : "purple";
}

// --- Version change kind (History tab) -----------------------------------------------------------------------------------------------
export const CHANGE_KIND_LABELS: Record<InvoiceVersionChangeKind, string> = {
  created: "Created",
  revised: "Revised",
  document_attached: "Document attached",
  reopened: "Reopened",
};
export function changeKindLabel(kind: InvoiceVersionChangeKind): string {
  return CHANGE_KIND_LABELS[kind];
}

// --- Event kinds (History tab) ----------------------------------------------------------------------------------------------------
export const EVENT_KIND_LABELS: Record<string, string> = {
  INVOICE_CREATED: "Invoice created",
  INVOICE_VERSION_CREATED: "Version created",
  INVOICE_DOCUMENT_ATTACHED: "Document attached",
  INVOICE_SUBMITTED: "Submitted",
  INVOICE_APPROVED: "Approved",
  INVOICE_REJECTED: "Rejected",
  INVOICE_REOPENED: "Reopened",
  INVOICE_VOIDED: "Voided",
  INVOICE_MISMATCH_ACCEPTED: "Mismatch accepted",
  PAYABLE_REVISION_DETECTED: "Payable revision detected",
};
export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}

// --- Source revision (section 21/15) ------------------------------------------------------------------------------------------------
export const SOURCE_REVISION_MESSAGES: Record<string, string> = {
  CURRENT: "This Invoice is based on the current Payable version.",
  PAYABLE_REVISION_AVAILABLE: "A newer Payable version is available. This Invoice remains pinned to the version it was built from.",
};
export function sourceRevisionMessage(state: string): string {
  return SOURCE_REVISION_MESSAGES[state] ?? state;
}

// --- Commercial period ------------------------------------------------------------------------------------------------------------
const PERIOD_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "2024-03" -> "March 2024". An unrecognized shape is returned verbatim (never guessed).
export function commercialPeriodLabel(periodKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!match) return periodKey;
  const [, year, month] = match;
  const index = Number(month) - 1;
  const name = PERIOD_MONTHS[index];
  return name ? `${name} ${year}` : periodKey;
}

// --- Money: integer minor units <-> rupee text, en-IN grouping, NO floating point -----------------------------------------------
const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹" };

export function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${groups.join(",")},${lastThree}`;
}

function splitMinor(absoluteMinor: number): { major: string; fraction: string } {
  const digits = String(absoluteMinor).padStart(3, "0");
  return { major: digits.slice(0, -2), fraction: digits.slice(-2) };
}

function moneyText(absoluteMinor: number, negative: boolean, currency: string | null, alwaysDecimals: boolean): string {
  const { major, fraction } = splitMinor(absoluteMinor);
  const number = groupIndianDigits(major) + (alwaysDecimals || fraction !== "00" ? `.${fraction}` : "");
  const code = (currency ?? "INR").toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const text = symbol ? `${symbol}${number}` : `${code} ${number}`;
  return negative ? `-${text}` : text;
}

// Invoice-declared amounts (subtotal / tax line / declared total) are UNSIGNED (amountMinorSchema:
// int >= 0). `null` means WITHHELD (the caller lacks `finance_amounts`) unless `amountsVisible` is
// false, in which case it is never rendered as "—" (which would look like a genuine unset value).
export function formatMoneyMinor(amountMinor: number | null, currency: string | null, options: { amountsVisible: boolean; alwaysDecimals?: boolean } = { amountsVisible: true }): string {
  if (!options.amountsVisible) return AMOUNT_HIDDEN_TEXT;
  if (amountMinor === null || !Number.isSafeInteger(amountMinor)) return NO_VALUE_TEXT;
  return moneyText(Math.abs(amountMinor), amountMinor < 0, currency, options.alwaysDecimals ?? false);
}

// The pinned Payable's expected total IS signed (payableExpectedTotalMinorSigned).
export function formatSignedMoneyMinor(amountMinorSigned: number | null, currency: string | null, options: { amountsVisible: boolean; alwaysDecimals?: boolean } = { amountsVisible: true }): string {
  if (!options.amountsVisible) return AMOUNT_HIDDEN_TEXT;
  if (amountMinorSigned === null || !Number.isSafeInteger(amountMinorSigned)) return NO_VALUE_TEXT;
  return moneyText(Math.abs(amountMinorSigned), amountMinorSigned < 0, currency, options.alwaysDecimals ?? false);
}

// The rupee text to PREFILL an amount input from a stored minor value: no symbol, no grouping.
export function minorToInputText(amountMinor: number | null): string {
  if (amountMinor === null || !Number.isSafeInteger(amountMinor)) return "";
  const { major, fraction } = splitMinor(Math.abs(amountMinor));
  return fraction === "00" ? major : `${major}.${fraction}`;
}

export type MoneyParseResult = { ok: true; amountMinor: number } | { ok: false; message: string };

// Parses what a person types for a declared amount ("35000", "35,000.5", "₹ 3,50,000") into an
// unsigned integer minor-units value. At most 2 decimal places (never silently rounded).
export function parseMoneyInputToMinor(input: string): MoneyParseResult {
  const text = input.replace(/^\s*₹/, "").replace(/\s+/g, "");
  if (text.length === 0) return { ok: false, message: "Enter an amount." };
  if (!/^(\d[\d,]*)?(\.\d*)?$/.test(text) || text === ".") return { ok: false, message: "Enter a valid amount, for example 35000 or 35,000.50." };
  const [wholeRaw = "", fractionRaw = ""] = text.split(".");
  if (/^,|,,|,$/.test(wholeRaw)) return { ok: false, message: "Enter a valid amount, for example 35000 or 35,000.50." };
  const whole = wholeRaw.replace(/,/g, "") || "0";
  if (fractionRaw.length > 2 && /[1-9]/.test(fractionRaw.slice(2))) return { ok: false, message: "Amounts allow at most 2 decimal places." };
  const fraction = (fractionRaw + "00").slice(0, 2);
  const minorText = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const amountMinor = Number(minorText);
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, message: "That amount is too large." };
  return { ok: true, amountMinor };
}

// --- Tax rate: basis points (1800 = 18.00%) <-> percent text ------------------------------------------------------------------------
export function ratePercentText(ratePercentBasisPoints: number | null): string {
  if (ratePercentBasisPoints === null) return NO_VALUE_TEXT;
  const percent = ratePercentBasisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

export function parseRatePercentToBasisPoints(input: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, message: "Enter a rate like 18 or 18.00." };
  const value = Math.round(Number(trimmed) * 100);
  if (value < 0 || value > 1_000_000) return { ok: false, message: "Enter a rate between 0 and 10000%." };
  return { ok: true, value };
}

// --- File size --------------------------------------------------------------------------------------------------------------------
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Refs (opaque, non-KYC identifiers only) ------------------------------------------------------------------------------------------
export function payablePinRefLabel(input: { payableRef: string; payableVersion: number }): string {
  return `${input.payableRef} · v${input.payableVersion}`;
}

export function agreementRefLabel(input: { agreementRef: string; agreementVersion: number }): string {
  return `${input.agreementRef} · v${input.agreementVersion}`;
}

export function reviewRefLabel(input: { reviewRef: string | null; reviewVersion: number | null }): string {
  if (input.reviewRef === null || input.reviewVersion === null) return NO_VALUE_TEXT;
  return `${input.reviewRef} · v${input.reviewVersion}`;
}
