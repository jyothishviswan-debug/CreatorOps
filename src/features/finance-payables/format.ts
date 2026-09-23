// Step 15B: display-only labels, tones, formatters and copy for the Finance Payables UI. Nothing here
// changes a stored value. Pure and browser-safe. Payables vocabulary only - a local copy of the small
// generic pieces (money, relative/absolute time) rather than importing from finance-agreements' own
// format module, matching that module's own "Finance never imports from another feature's format
// module" rule.
import { absoluteTime, relativeTime } from "@/features/administration/format";
import type {
  PayableCounterpartyType,
  PayableDeterminationState,
  PayableLineCategory,
  PayableLineSource,
  PayableReviewCode,
  PayableSourceCurrencyState,
  PayableSourceType,
  PayableStatus,
  PayableVersionChangeKind,
} from "@/server/finance-payables/types";

export { absoluteTime, relativeTime };

export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";
export type ChipSpec = { label: string; tone: PillTone };

export const NO_VALUE_TEXT = "—";
export const AMOUNT_HIDDEN_TEXT = "Hidden";

// --- Lifecycle status -----------------------------------------------------------------------------------------------------------------
export const PAYABLE_STATUS_CHIPS: Record<PayableStatus, ChipSpec> = {
  DRAFT: { label: "Draft", tone: "gray" },
  READY_FOR_INVOICE: { label: "Ready for invoice", tone: "default" },
  VOID: { label: "Void", tone: "red" },
};
export function payableStatusChip(status: PayableStatus): ChipSpec {
  return PAYABLE_STATUS_CHIPS[status];
}

// --- Determination ---------------------------------------------------------------------------------------------------------------------
export const DETERMINATION_CHIPS: Record<PayableDeterminationState, ChipSpec> = {
  DETERMINISTIC: { label: "Deterministic", tone: "default" },
  FINANCE_REVIEW_REQUIRED: { label: "Finance review required", tone: "orange" },
  BLOCKED: { label: "Blocked", tone: "red" },
};
export function determinationChip(state: PayableDeterminationState): ChipSpec {
  return DETERMINATION_CHIPS[state];
}

// --- Counterparty / source type ---------------------------------------------------------------------------------------------------------
export const COUNTERPARTY_TYPE_LABELS: Record<PayableCounterpartyType, string> = { PARTNER: "Partner", VENDOR: "Vendor" };
export function counterpartyTypeLabel(type: PayableCounterpartyType): string {
  return COUNTERPARTY_TYPE_LABELS[type];
}
export function counterpartyTypeTone(type: PayableCounterpartyType): PillTone {
  return type === "PARTNER" ? "blue" : "purple";
}

export const SOURCE_TYPE_LABELS: Record<PayableSourceType, string> = { PARTNER_REVIEW: "Partner Review", AGREEMENT_ONLY: "Agreement only" };
export function sourceTypeLabel(type: PayableSourceType): string {
  return SOURCE_TYPE_LABELS[type];
}

// --- Amount breakdown lines -------------------------------------------------------------------------------------------------------------
export const LINE_CATEGORY_LABELS: Record<PayableLineCategory, string> = {
  PRORATED_BASE: "Prorated service base",
  BASE_FIXED: "Base fixed amount",
  TRANSFER_FEE: "Transfer fee",
  GST: "GST amount",
  TDS: "TDS withheld",
  INCENTIVE: "Incentive",
  ADVANCE_ADJUSTMENT: "Advance adjustment",
  MANUAL_ADJUSTMENT: "Manual adjustment",
};
export function lineCategoryLabel(category: PayableLineCategory): string {
  return LINE_CATEGORY_LABELS[category];
}

export const LINE_SOURCE_LABELS: Record<PayableLineSource, string> = { AGREEMENT: "Agreement", PARTNER_REVIEW: "Partner Review", PLATFORM_RULE: "CreatorOps rule", MANUAL: "Manual" };
export function lineSourceLabel(source: PayableLineSource): string {
  return LINE_SOURCE_LABELS[source];
}

// A breakdown line's status: manual lines and engine-derived lines are always "Calculated" (they carry a
// concrete signed amount); a line never represents an unresolved item by itself - unresolved items are
// rendered as their own rows (see amount-view.ts). Kept here as a fixed chip for a line row.
export const LINE_STATUS_CALCULATED: ChipSpec = { label: "Calculated", tone: "default" };
export const REVIEW_NEEDED_CHIP: ChipSpec = { label: "Needs Finance review", tone: "orange" };

// The breakdown table's "Component" column for an unresolved (Finance-review) item - a short, human
// name for what the review code is about. The full plain-language reason is the backend's own
// `message` (never invented here).
export const REVIEW_CODE_COMPONENT_LABELS: Record<PayableReviewCode, string> = {
  NARRATIVE_INCENTIVE: "Incentive",
  ADVANCE_APPLICATION_UNSPECIFIED: "Advance adjustment",
  TRANSFER_FEE_APPLICATION_UNSPECIFIED: "Transfer fee",
  INCENTIVE_METRIC_EVIDENCE_MISSING: "Incentive",
  INCENTIVE_THRESHOLD_AMBIGUOUS: "Incentive",
  UNDER_DELIVERY_NO_STATED_CONSEQUENCE: "Qualifying content",
  REQUIRED_COUNT_EVIDENCE_MISSING_FOR_PRORATION: "Prorated service base",
  GST_RATE_UNKNOWN: "GST",
  TDS_RATE_UNKNOWN: "TDS",
};
export function reviewCodeComponentLabel(code: PayableReviewCode): string {
  return REVIEW_CODE_COMPONENT_LABELS[code];
}

export const CHANGE_KIND_LABELS: Record<PayableVersionChangeKind, string> = {
  created: "Created",
  revised: "Revised",
  adjustment_added: "Manual adjustment added",
  adjustment_removed: "Manual adjustment removed",
};
export function changeKindLabel(kind: PayableVersionChangeKind): string {
  return CHANGE_KIND_LABELS[kind];
}

// --- Event kinds (History tab) ----------------------------------------------------------------------------------------------------------
export const EVENT_KIND_LABELS: Record<string, string> = {
  PAYABLE_CREATED: "Created",
  PAYABLE_VERSION_CREATED: "Version created",
  MANUAL_ADJUSTMENT_ADDED: "Manual adjustment added",
  MANUAL_ADJUSTMENT_REMOVED: "Manual adjustment removed",
  PAYABLE_READY_FOR_INVOICE: "Ready for invoice",
  PAYABLE_VOIDED: "Voided",
  SOURCE_REVISION_DETECTED: "Source revision detected",
};
export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? kind;
}

// --- Source revision (Step 15A section 16) ------------------------------------------------------------------------------------------------
export const SOURCE_REVISION_MESSAGES: Record<PayableSourceCurrencyState, string> = {
  CURRENT: "This Payable is pinned to the current source evidence.",
  AGREEMENT_REVISION_AVAILABLE: "Newer source evidence is available. This Payable remains pinned to the versions shown below.",
  REVIEW_REVISION_AVAILABLE: "Newer source evidence is available. This Payable remains pinned to the versions shown below.",
  MULTIPLE_SOURCE_REVISIONS_AVAILABLE: "Newer source evidence is available. This Payable remains pinned to the versions shown below.",
};
export function sourceRevisionMessage(state: PayableSourceCurrencyState): string {
  return SOURCE_REVISION_MESSAGES[state];
}

// --- Commercial period ------------------------------------------------------------------------------------------------------------------
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

// --- Money: integer minor units (paise) <-> rupee text, en-IN grouping, NO floating point ------------------------------------------------
// Payables amounts are SIGNED (a deduction is negative): all arithmetic below is on digit strings, so
// precision is never lost and a negative amount is never silently shown as positive.
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

// `null` means WITHHELD (the caller lacks `finance_amounts`) - it is never rendered as "—" (which would
// look like a genuine zero/unset value); pass `amountsVisible` so the caller can tell the two apart.
export function formatSignedMoneyMinor(amountMinorSigned: number | null, currency: string | null, options: { amountsVisible: boolean; alwaysDecimals?: boolean } = { amountsVisible: true }): string {
  if (!options.amountsVisible) return AMOUNT_HIDDEN_TEXT;
  if (amountMinorSigned === null || !Number.isSafeInteger(amountMinorSigned)) return NO_VALUE_TEXT;
  const negative = amountMinorSigned < 0;
  const { major, fraction } = splitMinor(Math.abs(amountMinorSigned));
  const number = groupIndianDigits(major) + (options.alwaysDecimals || fraction !== "00" ? `.${fraction}` : "");
  const code = (currency ?? "INR").toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const text = symbol ? `${symbol}${number}` : `${code} ${number}`;
  return negative ? `-${text}` : text;
}

// The rupee text to PREFILL a manual-adjustment amount input from typed digits: no symbol, no grouping.
export function minorToInputText(amountMinorSigned: number | null): string {
  if (amountMinorSigned === null || !Number.isSafeInteger(amountMinorSigned)) return "";
  const negative = amountMinorSigned < 0;
  const { major, fraction } = splitMinor(Math.abs(amountMinorSigned));
  const text = fraction === "00" ? major : `${major}.${fraction}`;
  return negative ? `-${text}` : text;
}

export type MoneyParseResult = { ok: true; amountMinorSigned: number } | { ok: false; message: string };

// Parses what a person types for a manual adjustment ("−35000", "35,000.5", "₹ 3,50,000") into signed
// integer minor units. At most 2 decimal places (never silently rounded); a leading "-" or "−" is the
// only sign accepted; the result must be a safe integer.
export function parseSignedMoneyInputToMinor(input: string): MoneyParseResult {
  let text = input.replace(/^\s*₹/, "").replace(/\s+/g, "");
  let negative = false;
  if (text.startsWith("-") || text.startsWith("−")) {
    negative = true;
    text = text.slice(1);
  }
  if (text.length === 0) return { ok: false, message: "Enter an amount." };
  if (!/^(\d[\d,]*)?(\.\d*)?$/.test(text) || text === ".") return { ok: false, message: "Enter a valid amount, for example 35000 or -35,000.50." };
  const [wholeRaw = "", fractionRaw = ""] = text.split(".");
  if (/^,|,,|,$/.test(wholeRaw)) return { ok: false, message: "Enter a valid amount, for example 35000 or -35,000.50." };
  const whole = wholeRaw.replace(/,/g, "") || "0";
  if (fractionRaw.length > 2 && /[1-9]/.test(fractionRaw.slice(2))) return { ok: false, message: "Amounts allow at most 2 decimal places." };
  const fraction = (fractionRaw + "00").slice(0, 2);
  const minorText = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const amountMinor = Number(minorText);
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, message: "That amount is too large." };
  return { ok: true, amountMinorSigned: negative ? -amountMinor : amountMinor };
}

// --- Refs (opaque, non-KYC identifiers only) ------------------------------------------------------------------------------------------
export function sourceRefLabel(input: { agreementRef: string; agreementVersion: number; reviewRef: string | null; reviewVersion: number | null }): string {
  const agreement = `Agreement ${input.agreementRef} · v${input.agreementVersion}`;
  if (input.reviewRef === null || input.reviewVersion === null) return agreement;
  return `${agreement} · Partner Review ${input.reviewRef} · v${input.reviewVersion}`;
}
