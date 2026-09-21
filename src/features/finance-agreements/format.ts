import type { CSSProperties } from "react";

import { absoluteTime, relativeTime } from "@/features/administration/format";
import { platformLabel } from "@/features/content/format";
import { AGREEMENT_FIELD_BY_KEY, AGREEMENT_FIELD_KEYS, type AgreementFieldGroup, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import { AGREEMENT_TYPES, PAYMENT_CYCLES, type AgreementType, type PaymentCycle } from "@/server/finance-agreements/terms";
import type { AgreementEntryDecision, AgreementEventKind, AgreementFieldOrigin, AgreementHeadStatus, AgreementSourceMode, AgreementVersionStatus, CounterpartyType, ExtractionConfidence, ExtractionRunStatus } from "@/server/finance-agreements/types";
import type { AgreementDocumentStatusDto } from "@/server/finance-agreements/client-dto";
import type { ReconciliationReason, ReconciliationState } from "@/server/finance-agreements/reconciliation-compare";
import type { AgreementKycComponentStatus, AgreementKycState } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementWorkspacePrimaryActionKind } from "@/server/finance-agreements/workspace-dto";

// Step 14B: display-only labels, tones, formatters and copy for the Finance Agreements UI. Nothing here
// changes a stored value. Pure and browser-safe: it imports only the pure registry / terms modules
// (zod, no Firestore) at runtime and type-only everything else. Agreement vocabulary only: no other module's
// concepts appear in this folder (a static test enforces it).

export { absoluteTime, relativeTime, platformLabel };

// --- Tones & chips ------------------------------------------------------------------------------------------------------------------
export type PillTone = "default" | "orange" | "blue" | "purple" | "red" | "gray";

// One status chip = visible text + a tone. The text ALWAYS carries the meaning; the tone only supports it.
export type ChipSpec = { label: string; tone: PillTone };

// --- Copy constants (binding wording from the Step 14B design) -----------------------------------------------------------------------------
export const TARGET_MONITORING_LABEL = "Monitoring only · does not affect payment";
export const EXTRACTION_NOTE = "Extraction suggests values only. Review every field before confirming the Agreement.";
export const SCAN_MANUAL_REVIEW_MESSAGE = "Manual review required — no extractable text was found.";
export const CONTRACT_SOURCE_COPY = "Upload signed Agreement to extract and cross-check details";
export const MASTER_DATA_SOURCE_LABEL = "CreatorOps master data";
export const MASTER_DATA_SOURCE_NOTE = "Source: CreatorOps master data";
export const AGREEMENT_SOURCE_LABEL = "Agreement";
export const MANUAL_SOURCE_LABEL = "Manual";
export const KYC_AVAILABLE_NOTE = "KYC available in Partner/Vendor record";
export const NOT_AVAILABLE_IN_CREATOROPS = "Not available in CreatorOps";
export const RESTRICTED_VALUE_TEXT = "Restricted";
export const NEEDS_CONFIRMATION_LABEL = "Needs confirmation";
export const NEEDS_MAPPING_LABEL = "Needs mapping";
export const NO_VALUE_TEXT = "—";

// The visibly-disabled treatment, applied LOCALLY as an inline style only while a button is `disabled`
// (there is deliberately no global `.btn:disabled` rule). #5a6572 on #eceff2 = 5.14:1 contrast (>= 4.5:1).
// A local copy on purpose: Finance never imports from another feature's format module.
export const DISABLED_BUTTON_STYLE: CSSProperties = { background: "#eceff2", borderColor: "#d5dae0", color: "#5a6572", cursor: "not-allowed" };

// --- Lifecycle ------------------------------------------------------------------------------------------------------------------------
type LifecycleStatus = AgreementHeadStatus | AgreementVersionStatus;

export const LIFECYCLE_CHIPS: Record<LifecycleStatus, ChipSpec> = {
  DRAFT: { label: "Draft", tone: "gray" },
  ACTIVE: { label: "Active", tone: "default" },
  SUSPENDED: { label: "Suspended", tone: "orange" },
  ENDED: { label: "Ended", tone: "gray" },
  SUPERSEDED: { label: "Superseded", tone: "gray" },
};

export function lifecycleChip(status: LifecycleStatus): ChipSpec {
  return LIFECYCLE_CHIPS[status];
}
export const lifecycleLabel = (status: LifecycleStatus): string => LIFECYCLE_CHIPS[status].label;
export const lifecycleTone = (status: LifecycleStatus): PillTone => LIFECYCLE_CHIPS[status].tone;

// A version is a DRAFT until it is activated, but a CONFIRMED draft is a different thing from an editable one.
export function versionStatusChip(version: { status: AgreementVersionStatus; confirmed: boolean }): ChipSpec {
  if (version.status === "DRAFT" && version.confirmed) return { label: "Confirmed · not active", tone: "blue" };
  return LIFECYCLE_CHIPS[version.status];
}

export const SOURCE_MODE_LABELS: Record<AgreementSourceMode, string> = { MANUAL: "Manual", EXTRACTED: "Extracted", MIXED: "Mixed" };
export const sourceModeLabel = (mode: AgreementSourceMode | null | undefined): string => (mode ? SOURCE_MODE_LABELS[mode] : NO_VALUE_TEXT);

export const PRIMARY_ACTION_LABELS: Record<AgreementWorkspacePrimaryActionKind, string> = {
  CONTINUE_DRAFT: "Continue draft",
  REVIEW: "Review",
  CREATE_REVISION: "Create revision",
  OPEN: "Open",
};

export const COUNTERPARTY_TYPE_LABELS: Record<CounterpartyType, string> = { PARTNER: "Partner", VENDOR: "Vendor" };
export const counterpartyTypeLabel = (type: CounterpartyType): string => COUNTERPARTY_TYPE_LABELS[type];

export const EVENT_KIND_LABELS: Record<AgreementEventKind, string> = {
  created: "Agreement created",
  field_decided: "Field decided",
  extraction_attached: "Extraction attached",
  confirmed: "Version confirmed",
  activated: "Version activated",
  superseded: "Version superseded",
  revision_created: "Revision created",
  suspended: "Agreement suspended",
  resumed: "Agreement resumed",
  ended: "Agreement ended",
  master_data_updated: "Master data updated",
  kyc_updated_from_agreement: "KYC updated from Agreement",
  document_stored: "Agreement document stored",
  document_store_failed: "Agreement document not stored",
};
export const eventKindLabel = (kind: AgreementEventKind): string => EVENT_KIND_LABELS[kind] ?? "Activity";

// --- Extraction ------------------------------------------------------------------------------------------------------------------------
// Completeness of the extraction only - never legal verification.
export const EXTRACTION_STATUS_CHIPS: Record<ExtractionRunStatus, ChipSpec> = {
  EXTRACTED: { label: "Extracted", tone: "blue" },
  PARTIAL: { label: "Partial", tone: "orange" },
  MANUAL_REVIEW_REQUIRED: { label: "Manual review required", tone: "orange" },
};
export const extractionStatusChip = (status: ExtractionRunStatus): ChipSpec => EXTRACTION_STATUS_CHIPS[status];

export const CONFIDENCE_CHIPS: Record<ExtractionConfidence, ChipSpec> = {
  HIGH: { label: "High", tone: "default" },
  MEDIUM: { label: "Medium", tone: "blue" },
  LOW: { label: "Low", tone: "orange" },
  UNKNOWN: { label: "Unknown", tone: "gray" },
};
export const confidenceChip = (confidence: ExtractionConfidence | null | undefined): ChipSpec => CONFIDENCE_CHIPS[confidence ?? "UNKNOWN"];

// --- Field decisions & provenance ---------------------------------------------------------------------------------------------------------
export const DECISION_CHIPS: Record<AgreementEntryDecision, ChipSpec> = {
  PENDING: { label: NEEDS_CONFIRMATION_LABEL, tone: "orange" },
  ACCEPTED: { label: "Accepted", tone: "default" },
  CORRECTED: { label: "Corrected", tone: "blue" },
  UNAVAILABLE: { label: "Unavailable", tone: "gray" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "gray" },
};
export const decisionChip = (decision: AgreementEntryDecision): ChipSpec => DECISION_CHIPS[decision];

export const ORIGIN_LABELS: Record<AgreementFieldOrigin, string> = { MASTER_DATA: MASTER_DATA_SOURCE_LABEL, EXTRACTED: AGREEMENT_SOURCE_LABEL, MANUAL: MANUAL_SOURCE_LABEL };
export const originLabel = (origin: AgreementFieldOrigin): string => ORIGIN_LABELS[origin];

// --- Reconciliation (cross-verification) -----------------------------------------------------------------------------------------------------
export const RECONCILIATION_CHIPS: Record<ReconciliationState, ChipSpec> = {
  MATCH: { label: "Match", tone: "default" },
  MISSING_IN_CREATOROPS: { label: "Missing in CreatorOps", tone: "blue" },
  MISSING_IN_AGREEMENT: { label: "Missing in Agreement", tone: "blue" },
  MISMATCH: { label: "Mismatch", tone: "orange" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "gray" },
  RESTRICTED: { label: "Restricted", tone: "purple" },
  UNAVAILABLE: { label: "Unavailable", tone: "gray" },
};
export const reconciliationChip = (state: ReconciliationState): ChipSpec => RECONCILIATION_CHIPS[state];
export const reconciliationLabel = (state: ReconciliationState): string => RECONCILIATION_CHIPS[state].label;

export const RECONCILIATION_REASON_LABELS: Record<ReconciliationReason, string> = {
  no_canonical_field: "CreatorOps has no field for this yet.",
  canonical_unreadable: "The CreatorOps value could not be read.",
  canonical_value_not_comparable: "The CreatorOps value is not in a comparable form.",
  agreement_value_not_comparable: "The Agreement value is not in a comparable form.",
  not_applicable_to_counterparty: "This does not apply to this kind of counterparty.",
  decided_not_applicable: "Marked not applicable in this Agreement.",
  canonical_declares_not_applicable: "CreatorOps records this as not applicable.",
  nothing_to_compare: "Neither side has a value.",
  identity_access_required: "You do not have access to compare restricted details.",
};
export const reconciliationReasonLabel = (reason: ReconciliationReason | null | undefined): string | null => (reason ? (RECONCILIATION_REASON_LABELS[reason] ?? null) : null);

// --- KYC ----------------------------------------------------------------------------------------------------------------------------------------
export const KYC_STATE_CHIPS: Record<AgreementKycState, ChipSpec> = {
  AVAILABLE: { label: "Available", tone: "default" },
  MISSING: { label: "Missing", tone: "orange" },
  INCOMPLETE: { label: "Incomplete", tone: "orange" },
  RESTRICTED: { label: "Restricted", tone: "purple" },
  UNAVAILABLE: { label: "Unavailable", tone: "gray" },
};
export const kycStateChip = (state: AgreementKycState): ChipSpec => KYC_STATE_CHIPS[state];

// A component's presence in the owning Partner / Vendor KYC record (status only, never a value).
export const KYC_COMPONENT_CHIPS: Record<AgreementKycComponentStatus, ChipSpec> = {
  PRESENT: { label: "Available", tone: "default" },
  MISSING: { label: "Missing", tone: "orange" },
  INCOMPLETE: { label: "Incomplete", tone: "orange" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "gray" },
  RESTRICTED: { label: "Restricted", tone: "purple" },
};
export const kycComponentChip = (status: AgreementKycComponentStatus): ChipSpec => KYC_COMPONENT_CHIPS[status];

export type KycComponentKey = "pan" | "aadhaar" | "gst" | "bank";
export const KYC_COMPONENT_LABELS: Record<KycComponentKey, string> = { pan: "PAN", aadhaar: "Aadhaar", gst: "GST certificate", bank: "Bank details" };
export const kycComponentLabel = (component: KycComponentKey): string => KYC_COMPONENT_LABELS[component];

// --- Agreement document (the ORIGINAL signed PDF, kept in Drive after confirmation) ---------------------------------------------------------------------
// The text always carries the meaning. "Stored" is the ONLY green state; nothing here ever claims a document is stored unless the server said STORED.
export const DOCUMENT_STATUS_CHIPS: Record<AgreementDocumentStatusDto, ChipSpec> = {
  STORED: { label: "Stored", tone: "default" },
  PENDING: { label: "Not stored yet", tone: "orange" },
  FAILED: { label: "Storage failed", tone: "red" },
  NOT_CONFIGURED: { label: "Drive storage not configured", tone: "orange" },
  NOT_APPLICABLE: { label: "No new signed document", tone: "gray" },
};
export const documentStatusChip = (status: AgreementDocumentStatusDto): ChipSpec => DOCUMENT_STATUS_CHIPS[status];
export const AGREEMENT_DOCUMENT_LABEL = "Agreement document";
export const OPEN_AGREEMENT_DOCUMENT_LABEL = "Open Agreement document";
export const STORE_AGREEMENT_DOCUMENT_LABEL = "Store Agreement document";
export const AGREEMENT_DOCUMENT_ON_FILE = "Agreement document on file";
export const DRIVE_NOT_CONFIGURED_TEXT = "Drive storage not configured";
export const NO_NEW_SIGNED_DOCUMENT_TEXT = "No new signed document for this version";

// --- Registry-driven field labels ----------------------------------------------------------------------------------------------------------------
// The registry's own labels are the source; only these are re-worded to the canonical Step 14B terminology.
const FIELD_LABEL_OVERRIDES: Partial<Record<AgreementFieldKey, string>> = {
  monthlyRequiredQualifyingContentCount: "Monthly required qualifying content",
  lfcSfc: "LFC / SFC rule",
  performanceTargets: "Performance targets",
  agreementType: "Agreement type",
  remarks: "Remarks (internal notes)",
  gstin: "GSTIN",
};

export function fieldLabel(key: AgreementFieldKey): string {
  return FIELD_LABEL_OVERRIDES[key] ?? AGREEMENT_FIELD_BY_KEY[key]?.label ?? key;
}

// Every registry key -> its human label (a total map, built from the registry so a new key can never be unlabeled).
export const FIELD_LABELS: Record<AgreementFieldKey, string> = Object.fromEntries(AGREEMENT_FIELD_KEYS.map((key) => [key, fieldLabel(key)])) as Record<AgreementFieldKey, string>;

export const FIELD_GROUP_LABELS: Record<AgreementFieldGroup, string> = {
  counterparty_contact: "Counterparty & contact",
  identity: "KYC & restricted details",
  partner_platform: "Platform & account",
  dates_terms: "Dates & clauses",
  commercial: "Commercial terms",
  targets: "Performance targets",
  admin: "Additional details",
};

// --- Qualifying unit (only the two units Step 14A supports) ---------------------------------------------------------------------------------------
export const QUALIFYING_UNIT_OPTIONS = [
  { value: "approved_content_thread", label: "Approved Content" },
  { value: "approved_current_link", label: "Approved current link" },
] as const;
export type SupportedQualifyingUnit = (typeof QUALIFYING_UNIT_OPTIONS)[number]["value"];

export function isSupportedQualifyingUnit(value: unknown): value is SupportedQualifyingUnit {
  return typeof value === "string" && QUALIFYING_UNIT_OPTIONS.some((option) => option.value === value);
}

// Supported value -> its human label. Anything else is shown AS WRITTEN (never silently mapped) - callers
// pair it with NEEDS_MAPPING_LABEL.
export function qualifyingUnitLabel(value: string | null | undefined): string {
  if (!value) return NO_VALUE_TEXT;
  return QUALIFYING_UNIT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

// --- Payment cycle / Agreement type / platform ----------------------------------------------------------------------------------------------------
export const PAYMENT_CYCLE_LABELS: Record<PaymentCycle, string> = { WEEKLY: "Weekly", FORTNIGHTLY: "Fortnightly", MONTHLY: "Monthly", QUARTERLY: "Quarterly", ONE_TIME: "One-time", OTHER: "Other" };
export const PAYMENT_CYCLE_OPTIONS: ReadonlyArray<{ value: PaymentCycle; label: string }> = PAYMENT_CYCLES.map((value) => ({ value, label: PAYMENT_CYCLE_LABELS[value] }));
export const paymentCycleLabel = (value: string | null | undefined): string => (value ? (PAYMENT_CYCLE_LABELS[value as PaymentCycle] ?? value) : NO_VALUE_TEXT);

export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  FIXED_ONLY: "Fixed only",
  FIXED_PLUS_INCENTIVE: "Fixed + incentive",
  FIXED_PLUS_REQUIRED_CONTENT: "Fixed + required content",
  FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT: "Fixed + incentive + required content",
  REQUIRED_CONTENT_BASED: "Required content based",
  INCENTIVE_BASED: "Incentive based",
  INCENTIVE_PLUS_REQUIRED_CONTENT: "Incentive + required content",
  UNSPECIFIED: "Unspecified",
};
export const AGREEMENT_TYPE_OPTIONS: ReadonlyArray<{ value: AgreementType; label: string }> = AGREEMENT_TYPES.map((value) => ({ value, label: AGREEMENT_TYPE_LABELS[value] }));
export const agreementTypeLabel = (value: string | null | undefined): string => (value ? (AGREEMENT_TYPE_LABELS[value as AgreementType] ?? value) : NO_VALUE_TEXT);

// "instagram" -> "Instagram", "youtube" -> "YouTube" (display only; the stored id stays normalized lower-case).
export function formatPlatformName(value: string): string {
  return value.trim().toLowerCase() === "youtube" ? "YouTube" : platformLabel(value);
}
export function formatPlatformList(values: readonly string[]): string {
  return values.length === 0 ? NO_VALUE_TEXT : values.map(formatPlatformName).join(" + ");
}

// --- Money: integer minor units (paise) <-> rupee text, en-IN grouping, NO floating point ----------------------------------------------------------
// Every currency Step 14A stores has 2 minor digits. All arithmetic below is on digit STRINGS, so 19.99 can never
// become 1998.9999999999998 and a large amount never loses precision.
const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹" };

// Indian digit grouping of a digits-only string: 1234567 -> "12,34,567".
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

function isMinorUnits(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Splits integer minor units into { major, fraction } digit strings ("3500050" -> { major: "35000", fraction: "50" }).
function splitMinor(amountMinor: number): { major: string; fraction: string } {
  const digits = String(amountMinor).padStart(3, "0");
  return { major: digits.slice(0, -2), fraction: digits.slice(-2) };
}

// "₹35,000" / "₹35,000.50" (fraction shown only when it is not .00, or when alwaysDecimals). Non-INR: "USD 1,000".
// null / undefined / a non-integer / negative => "—" (never a guessed number).
export function formatMoneyMinor(amountMinor: number | null | undefined, currency: string | null | undefined = "INR", options: { alwaysDecimals?: boolean } = {}): string {
  if (!isMinorUnits(amountMinor)) return NO_VALUE_TEXT;
  const { major, fraction } = splitMinor(amountMinor);
  const number = groupIndianDigits(major) + (options.alwaysDecimals || fraction !== "00" ? `.${fraction}` : "");
  const code = (currency ?? "INR").toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${number}` : `${code} ${number}`;
}

// The rupee text to PREFILL an amount input from stored minor units: no symbol, no grouping ("35000", "35000.5" -> "35000.50").
export function minorToInputText(amountMinor: number | null | undefined): string {
  if (!isMinorUnits(amountMinor)) return "";
  const { major, fraction } = splitMinor(amountMinor);
  return fraction === "00" ? major : `${major}.${fraction}`;
}

export type MoneyParseResult = { ok: true; amountMinor: number } | { ok: false; message: string };

// Parses what a person types ("35000", "35,000.5", "₹ 3,50,000", ".5") into integer minor units.
// Rules: non-negative; at most 2 decimal places (more digits are rejected unless they are all zero - never silently
// rounded); commas allowed in the whole part only; a leading rupee sign and spaces are ignored; the result must be a safe integer.
export function parseMoneyInputToMinor(input: string): MoneyParseResult {
  const text = input.replace(/^\s*₹/, "").replace(/\s+/g, "");
  if (text.length === 0) return { ok: false, message: "Enter an amount." };
  if (text.startsWith("-")) return { ok: false, message: "An amount cannot be negative." };
  if (!/^(\d[\d,]*)?(\.\d*)?$/.test(text) || text === ".") return { ok: false, message: "Enter a valid amount, for example 35000 or 35,000.50." };
  const [wholeRaw = "", fractionRaw = ""] = text.split(".");
  if (/^,|,,|,$/.test(wholeRaw)) return { ok: false, message: "Enter a valid amount, for example 35000 or 35,000.50." };
  if (fractionRaw.length > 2 && /[1-9]/.test(fractionRaw.slice(2))) return { ok: false, message: "Use at most 2 decimal places." };
  const whole = wholeRaw.replace(/,/g, "").replace(/^0+(?=\d)/, "") || "0";
  const minorText = `${whole}${fractionRaw.slice(0, 2).padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
  const amountMinor = Number(minorText);
  if (minorText.length > 16 || !Number.isSafeInteger(amountMinor)) return { ok: false, message: "That amount is too large." };
  return { ok: true, amountMinor };
}

// --- Dates ---------------------------------------------------------------------------------------------------------------------------------------
// Agreement dates are calendar dates (YYYY-MM-DD, no time zone). They are formatted in UTC from the string itself so a
// browser in another time zone can never show the previous/next day and SSR and hydration always agree.
const UTC_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
}

// "2026-09-14" -> "14 Sep 2026"; null -> "—"; a malformed string is returned as written.
export function formatUtcDate(value: string | null | undefined): string {
  if (!value) return NO_VALUE_TEXT;
  if (!isUtcDate(value)) return value;
  const [year, month, day] = value.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// "14 Sep 2026 – 13 Sep 2027" / "From 14 Sep 2026" (open-ended) / "—".
export function formatEffectivePeriod(effectiveFrom: string | null | undefined, effectiveTo: string | null | undefined): string {
  if (!effectiveFrom && !effectiveTo) return NO_VALUE_TEXT;
  if (effectiveFrom && !effectiveTo) return `From ${formatUtcDate(effectiveFrom)}`;
  if (!effectiveFrom) return `Until ${formatUtcDate(effectiveTo)}`;
  return `${formatUtcDate(effectiveFrom)} – ${formatUtcDate(effectiveTo)}`;
}

// The current UTC calendar date as YYYY-MM-DD (injectable clock for tests).
export function todayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Instants (createdAt / updatedAt / confirmedAt ...): "14 Sep 2026, 10:24" and "3h ago" come from the shared Administration
// helpers; a missing instant renders as "—".
export function formatInstant(iso: string | null | undefined): string {
  return iso ? absoluteTime(iso) : NO_VALUE_TEXT;
}
export function formatRelativeInstant(iso: string | null | undefined): string {
  return iso ? relativeTime(iso) : NO_VALUE_TEXT;
}

// --- Contract file (client pre-check; the server is the truth) ------------------------------------------------------------------------------------
export const CONTRACT_MAX_BYTES = 10 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_VALUE_TEXT;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// null = acceptable for upload; otherwise the message to show. PDF only, non-empty, at most 10 MB.
export function checkContractFile(file: { name: string; size: number; type?: string }): string | null {
  const looksLikePdf = /\.pdf$/i.test(file.name) && (file.type === undefined || file.type === "" || file.type === "application/pdf");
  if (!looksLikePdf) return "Only PDF files can be uploaded.";
  if (file.size <= 0) return "This file is empty.";
  if (file.size > CONTRACT_MAX_BYTES) return `This file is ${formatFileSize(file.size)}. The limit is 10 MB.`;
  return null;
}
