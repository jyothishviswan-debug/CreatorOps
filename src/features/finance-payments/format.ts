// Step 17B: display-only labels, tones, formatters and copy for the Finance Payments UI. Nothing
// here changes a stored value. Pure and browser-safe. Payments vocabulary only - a local copy of
// the small generic pieces (money, relative/absolute time), matching Payables'/Invoices' own
// "Finance never imports from another feature's format module" rule.
import { absoluteTime, relativeTime } from "@/features/administration/format";
import type { PaymentCounterpartyType, PaymentMethod, PaymentSettlementState, PaymentStatus, PaymentVersionChangeKind } from "@/server/finance-payments/types";

export { absoluteTime, relativeTime };

export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";
export type ChipSpec = { label: string; tone: PillTone };

export const NO_VALUE_TEXT = "—";
export const AMOUNT_HIDDEN_TEXT = "Hidden";

// --- Lifecycle status ---------------------------------------------------------------------------------------------------------------
export const PAYMENT_STATUS_CHIPS: Record<PaymentStatus, ChipSpec> = {
  DRAFT: { label: "Draft", tone: "gray" },
  RECORDED: { label: "Recorded", tone: "orange" },
  CONFIRMED: { label: "Confirmed", tone: "default" },
  FAILED: { label: "Failed", tone: "red" },
  VOID: { label: "Void", tone: "red" },
};
export function paymentStatusChip(status: PaymentStatus): ChipSpec {
  return PAYMENT_STATUS_CHIPS[status];
}

// --- Settlement state ----------------------------------------------------------------------------------------------------------------
export const SETTLEMENT_STATE_CHIPS: Record<PaymentSettlementState, ChipSpec> = {
  UNPAID: { label: "Unpaid", tone: "gray" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "orange" },
  PAID: { label: "Paid", tone: "default" },
  OVERPAID: { label: "Review required", tone: "red" },
  REVIEW_REQUIRED: { label: "Review required", tone: "red" },
};
export function settlementStateChip(state: PaymentSettlementState): ChipSpec {
  return SETTLEMENT_STATE_CHIPS[state];
}

// --- Payment method -------------------------------------------------------------------------------------------------------------------
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: "Bank transfer",
  UPI: "UPI",
  CHEQUE: "Cheque",
  CASH: "Cash",
  OTHER: "Other",
};
export function paymentMethodLabel(method: PaymentMethod | null): string {
  return method ? PAYMENT_METHOD_LABELS[method] : NO_VALUE_TEXT;
}
export const PAYMENT_METHOD_OPTIONS: ReadonlyArray<{ value: PaymentMethod; label: string }> = (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }));

// --- Counterparty -----------------------------------------------------------------------------------------------------------------------
export const COUNTERPARTY_TYPE_LABELS: Record<PaymentCounterpartyType, string> = { PARTNER: "Partner", VENDOR: "Vendor" };
export function counterpartyTypeLabel(type: PaymentCounterpartyType): string {
  return COUNTERPARTY_TYPE_LABELS[type];
}
export function counterpartyTypeTone(type: PaymentCounterpartyType): PillTone {
  return type === "PARTNER" ? "blue" : "purple";
}

// --- Version change kind (History tab) -----------------------------------------------------------------------------------------------
export const CHANGE_KIND_LABELS: Record<PaymentVersionChangeKind, string> = {
  created: "Created",
  revised: "Revised",
  reopened: "Reopened",
};
export function changeKindLabel(kind: PaymentVersionChangeKind): string {
  return CHANGE_KIND_LABELS[kind];
}

// --- Event kinds (History tab) ----------------------------------------------------------------------------------------------------
export const EVENT_KIND_LABELS: Record<string, string> = {
  PAYMENT_CREATED: "Payment created",
  PAYMENT_VERSION_CREATED: "Version created",
  PAYMENT_RECORDED: "Recorded",
  PAYMENT_CONFIRMED: "Confirmed",
  PAYMENT_FAILED: "Marked failed",
  PAYMENT_VOIDED: "Voided",
  PAYMENT_REOPENED: "Reopened",
  PAYMENT_OVERPAYMENT_OVERRIDE: "Overpayment override accepted",
  PAYMENT_CONFIRMED_REVERSED: "Confirmed payment reversed",
  PAYMENT_SOURCE_REVISION_DETECTED: "Source revision detected",
};
export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}

// --- Source revision (section 18) -------------------------------------------------------------------------------------------------
export const SOURCE_REVISION_MESSAGES: Record<string, string> = {
  CURRENT: "This Payment is pinned to the current approved Invoice version.",
  INVOICE_REVISION_AVAILABLE: "A newer Invoice/Payable version exists. This Payment remains pinned to the approved source version used when it was created.",
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

// Payment amounts are always UNSIGNED (positiveAmountMinorSchema / amountMinorSchema: int >= 0/1).
// `null` means WITHHELD (the caller lacks `finance_amounts`) unless `amountsVisible` is false, in
// which case it is never rendered as "—" (which would look like a genuine unset value).
export function formatMoneyMinor(amountMinor: number | null, currency: string | null, options: { amountsVisible: boolean; alwaysDecimals?: boolean } = { amountsVisible: true }): string {
  if (!options.amountsVisible) return AMOUNT_HIDDEN_TEXT;
  if (amountMinor === null || !Number.isSafeInteger(amountMinor)) return NO_VALUE_TEXT;
  return moneyText(Math.abs(amountMinor), amountMinor < 0, currency, options.alwaysDecimals ?? false);
}

// The rupee text to PREFILL an amount input from a stored minor value: no symbol, no grouping.
export function minorToInputText(amountMinor: number | null): string {
  if (amountMinor === null || !Number.isSafeInteger(amountMinor)) return "";
  const { major, fraction } = splitMinor(Math.abs(amountMinor));
  return fraction === "00" ? major : `${major}.${fraction}`;
}

export type MoneyParseResult = { ok: true; amountMinor: number } | { ok: false; message: string };

// Parses what a person types for a Payment amount ("35000", "35,000.5", "₹ 3,50,000") into an
// unsigned, POSITIVE integer minor-units value (a Payment amount is never zero - section 8). At
// most 2 decimal places (never silently rounded).
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
  if (amountMinor <= 0) return { ok: false, message: "Enter an amount greater than zero." };
  return { ok: true, amountMinor };
}

// The current UTC calendar date as YYYY-MM-DD (injectable clock for tests).
export function todayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// --- Refs (opaque, non-KYC identifiers only) ------------------------------------------------------------------------------------------
export function invoicePinRefLabel(input: { invoiceRef: string; invoiceVersion: number }): string {
  return `${input.invoiceRef} · v${input.invoiceVersion}`;
}
export function payablePinRefLabel(input: { payableRef: string; payableVersion: number }): string {
  return `${input.payableRef} · v${input.payableVersion}`;
}

// --- Payee identity status (already-masked, section 12/20) --------------------------------------------------------------------------
export const PAYEE_IDENTITY_STATUS_LABELS: Record<string, string> = {
  MATCH: "Match",
  PARTIAL_MATCH: "Partial match",
  MISMATCH: "Mismatch",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  REVIEW_REQUIRED: "Review required",
  OVERRIDDEN: "Accepted with reason",
};
export function payeeIdentityStatusLabel(status: string | null): string {
  if (status === null) return "Not yet checked";
  return PAYEE_IDENTITY_STATUS_LABELS[status] ?? status;
}
export function payeeIdentityStatusTone(status: string | null): PillTone {
  if (status === null) return "gray";
  if (status === "MATCH") return "default";
  if (status === "OVERRIDDEN") return "blue";
  if (status === "MISMATCH") return "red";
  return "orange";
}
