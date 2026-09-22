import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { ConfirmedAgreementTerms, ContactSnapshot, ContentObligation, IncentiveSlab, PerformanceTarget } from "@/server/finance-agreements/terms";

import {
  NO_VALUE_TEXT,
  agreementTypeLabel,
  formatMoneyMinor,
  formatPlatformList,
  formatUtcDate,
  paymentCycleLabel,
} from "./format";
import { mapQualifyingUnit } from "./qualifying-unit";
import { targetMetricLabel } from "./target-metrics";

// Step 14B: reading and displaying field VALUES (pure). Draft entries and confirmed terms share the registry's
// `path` addressing; these helpers are the one place that knows how to turn a stored value into text.

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[key];
    if (node === undefined) return null;
  }
  return node ?? null;
}

// The value a registry field holds in a CONFIRMED version: `terms` fields read their path in the terms,
// `contactSnapshot` fields their key in the snapshot; identity / counterparty fields carry no stored value (null).
export function confirmedFieldValue(key: AgreementFieldKey, terms: ConfirmedAgreementTerms | null, contact: ContactSnapshot | null): unknown {
  const field = AGREEMENT_FIELD_BY_KEY[key];
  if (!field.path) return null;
  if (field.target === "terms") return terms ? readPath(terms, field.path) : null;
  if (field.target === "contactSnapshot") return contact ? readPath(contact, field.path) : null;
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function money(amountMinor: unknown, currency: string | null): string {
  return typeof amountMinor === "number" ? formatMoneyMinor(amountMinor, currency ?? "INR") : NO_VALUE_TEXT;
}

// "₹35,000" / "Not applicable" / "—" for the { applicable, amountMinor, details? } shapes.
function componentText(value: unknown, currency: string | null): string {
  if (!isRecord(value)) return NO_VALUE_TEXT;
  if (value.applicable !== true) return "Not applicable";
  const parts: string[] = [];
  if (typeof value.amountMinor === "number") parts.push(money(value.amountMinor, currency));
  if (typeof value.details === "string" && value.details.length > 0) parts.push(value.details);
  return parts.length > 0 ? parts.join(" · ") : "Applicable";
}

export function incentiveSlabSummary(slab: IncentiveSlab, currency: string | null): string {
  const range = slab.upperBound === null ? `${slab.lowerBound}+` : `${slab.lowerBound}–${slab.upperBound}`;
  return `${targetMetricLabel(slab.metricId)}: ${range} ${slab.unit} → ${money(slab.amountMinor, currency)}`;
}

// A target's metric id is a raw registry/analytics id (e.g. "followerGrowth") - never shown as typed; targetMetricLabel()
// turns a known one into its human label ("Follower growth") and otherwise falls back to the id as written.
// FINAL_EXECUTION #18: the contract's own period wording is shown as written; a target with no stated period reads
// "Period not specified" - never a guessed/invented cadence such as "monthly".
export function performanceTargetSummary(target: PerformanceTarget): string {
  return `${targetMetricLabel(target.metricId)}: at least ${target.targetValue} ${target.unit} · ${target.period ?? "Period not specified"}`;
}

// FINAL_EXECUTION #15: a repeatable content-obligation row. A missing operational mapping reads "Needs mapping" -
// the contract's own wording is never silently converted to a CreatorOps operational unit.
export function contentObligationSummary(row: ContentObligation): string {
  return `${row.label}: ${row.quantity}${row.period ? ` · ${row.period}` : ""} · ${row.operationalMapping ?? "Needs mapping"}`;
}

// A short, safe text for any registry field's value (a draft entry's value or a confirmed term). Identity VALUE fields
// have no value by construction and always render as the dash. `context.currency` formats the money components.
export function formatFieldValue(key: AgreementFieldKey, value: unknown, context: { currency?: string | null } = {}): string {
  const field = AGREEMENT_FIELD_BY_KEY[key];
  if (field.identityValue) return NO_VALUE_TEXT;
  if (value === null || value === undefined) return NO_VALUE_TEXT;
  const currency = context.currency ?? null;

  switch (key) {
    case "signedDate":
    case "effectiveDate":
    case "terminationDate":
      return typeof value === "string" ? formatUtcDate(value) : NO_VALUE_TEXT;
    case "paymentCycle":
      return paymentCycleLabel(typeof value === "string" ? value : null);
    case "agreementType":
      return agreementTypeLabel(typeof value === "string" ? value : null);
    case "qualifyingUnit": {
      const mapping = mapQualifyingUnit(value);
      if (mapping.state === "SUPPORTED") return mapping.label;
      return mapping.state === "NEEDS_MAPPING" ? mapping.extractedWording : NO_VALUE_TEXT;
    }
    case "platforms":
      return Array.isArray(value) ? formatPlatformList(value.filter((item): item is string => typeof item === "string")) : NO_VALUE_TEXT;
    case "invoiceRequired":
    case "onboardingProcessCompleted":
      return typeof value === "boolean" ? (value ? "Yes" : "No") : NO_VALUE_TEXT;
    case "fixedComponent":
    case "accountTransferFee":
    case "advancePayment":
      return componentText(value, currency);
    case "incentive": {
      if (!isRecord(value)) return NO_VALUE_TEXT;
      if (value.applicable !== true) return "Not applicable";
      const slabs = Array.isArray(value.slabs) ? value.slabs : [];
      return `${slabs.length} slab${slabs.length === 1 ? "" : "s"}`;
    }
    case "lfcSfc": {
      if (!isRecord(value) || !isRecord(value.byFormat)) return NO_VALUE_TEXT;
      const count = Object.keys(value.byFormat).length;
      return `${count} format${count === 1 ? "" : "s"}`;
    }
    case "performanceTargets": {
      if (!Array.isArray(value)) return NO_VALUE_TEXT;
      return value.length === 0 ? "None" : `${value.length} target${value.length === 1 ? "" : "s"}`;
    }
    case "monthlyRequiredQualifyingContentCount":
      return typeof value === "number" ? String(value) : NO_VALUE_TEXT;
    default:
      if (typeof value === "string") return value.length > 0 ? value : NO_VALUE_TEXT;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (Array.isArray(value)) return value.map(String).join(", ");
      return NO_VALUE_TEXT;
  }
}
