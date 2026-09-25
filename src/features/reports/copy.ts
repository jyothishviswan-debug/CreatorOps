import type { ReportId } from "@/server/reports";
import type { ReportFilterFieldType, ReportRowValue } from "@/server/reports/types";

// Step 19B: display-only labels, formatters and organizing structure for the Reports UI. Nothing
// here changes, recomputes, or invents a value - every figure rendered through these helpers is
// exactly what the governed ReportResult already contains. Own local copy module (not a cross-import
// from another feature's format.ts), matching src/features/operations/copy.ts's own precedent and
// stated reasoning for keeping each feature's formatting local.

export const NO_VALUE_TEXT = "—";

// A fixed locale ("en-GB"), never `undefined` - avoids a server/browser locale mismatch on
// hydration (see src/features/operations/copy.ts's own comment for the exact bug this avoids).
const DATE_LOCALE = "en-GB";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE_TEXT;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NO_VALUE_TEXT;
  return date.toLocaleString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// "2026-05" -> "May 2026". An unrecognized shape is returned verbatim (never guessed).
const PERIOD_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function periodKeyLabel(periodKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!match) return periodKey;
  const [, year, month] = match;
  const name = PERIOD_MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : periodKey;
}

// --- Report family organization for the catalog page --------------------------------------------
// Mirrors catalog.ts's own section comments exactly (section 12 "high-value" six, the three
// additional fully-executed families, and the four Step 19A.1 "management-scale" families) - a
// real, already-authored grouping this UI reuses rather than inventing its own.
export type ReportFamilyGroupKey = "high_value" | "additional" | "management_scale";
export const REPORT_FAMILY_GROUPS: { key: ReportFamilyGroupKey; label: string; description: string; reportIds: ReportId[] }[] = [
  {
    key: "high_value",
    label: "High-value operational reports",
    description: "The six families the Reports foundation was built around first - fulfillment, verified outcomes, freshness, review evidence, finance status and live operational attention.",
    reportIds: ["campaign_delivery", "campaign_performance", "channel_growth_freshness", "partner_review_evidence", "finance_status", "operations_attention"],
  },
  {
    key: "additional",
    label: "Additional operational reports",
    description: "Existing canonical sources given the same governed execution as the six above.",
    reportIds: ["discovery_funnel", "partner_portfolio", "administration_security"],
  },
  {
    key: "management_scale",
    label: "Management-scale reports",
    description: "Composed, multi-source views spanning Partners, Analytics, Partner Reviews and Campaigns - including one bounded multi-period trend.",
    reportIds: ["monthly_partner_performance", "campaign_event_performance", "cross_platform_partner_programme", "long_period_partner_programme"],
  },
];

// A client-side echo of report-service.ts's own VIEWER_SAFE_BLOCKED_REPORT_IDS, used ONLY to show an
// honest, immediate message instead of a wasted round trip for a Viewer - never the authority. The
// server independently re-enforces this on every viewer-run call regardless of what this list says;
// if the two ever drift, a stale entry here only costs one extra denied round trip (still rendered
// honestly through the real API error), never a false grant.
export const VIEWER_SAFE_BLOCKED_REPORT_IDS: ReadonlySet<ReportId> = new Set(["finance_status", "administration_security"]);

// --- Filter field UI -------------------------------------------------------------------------------
export const PLATFORM_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
];

export const FILTER_TYPE_HINT: Record<ReportFilterFieldType, string> = {
  period: "A single period, YYYY-MM.",
  periodRange: "Up to 6 periods, YYYY-MM each.",
  partnerRef: "The exact Partner reference.",
  partnerAccountRef: "The exact Partner Account reference.",
  campaignRef: "The exact Campaign reference.",
  platform: "Instagram or YouTube.",
  status: "The exact lifecycle status value.",
};

// --- Metric value rendering (section 5/6: a missing metric is never 0, never blank-implying-zero) ---
export function formatMetricValue(value: number | string | null): string {
  if (value === null) return "Not available";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(DATE_LOCALE) : String(value);
  // A string metric value is sometimes itself a period key (e.g. leaderPeriodByViews_instagram) -
  // render it in its human label form when it looks like one, verbatim otherwise.
  return /^\d{4}-\d{2}$/.test(value) ? periodKeyLabel(value) : value;
}

// --- Section/row rendering: column headers are derived mechanically from the real field names a
// family projector already returned (see e.g. families/campaign-delivery.ts's own row shapes) -
// never invented, never a fabricated business label beyond what the key itself names.
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// A conservative allowlist: only a column name this app already knows maps to one of its own real
// detail routes ever becomes a link - never a guess at an unfamiliar ref shape, and never a route
// outside this app. The destination route re-authorizes the record normally (a denied/not-found
// target renders that route's own neutral state, never a Reports-side hint).
const REF_LINK_ROUTES: Record<string, (value: string) => string> = {
  partnerRef: (v) => `/partners/${encodeURIComponent(v)}`,
  campaignRef: (v) => `/campaigns/${encodeURIComponent(v)}`,
  vendorRef: (v) => `/vendors/${encodeURIComponent(v)}`,
  assignmentRef: (v) => `/assignments/${encodeURIComponent(v)}`,
  contentRef: (v) => `/content/${encodeURIComponent(v)}`,
  reviewRef: (v) => `/partner-reviews/${encodeURIComponent(v)}`,
};

// Operations' own TargetReference shape ({targetType, targetRef, targetVersion?}) - the ONE known
// nested-object shape that shows up inside a section row today (operations_attention's sections.tasks
// / sections.reminders carry the raw TaskDto/ReminderDto straight through, target field included -
// see families/operations-attention.ts). Mapped to the same real routes Operations' own
// target-links.ts already resolves for a subset of target types; an unmapped type renders as plain
// text, never a broken link.
const TARGET_TYPE_ROUTES: Record<string, (ref: string) => string> = {
  PARTNER: (v) => `/partners/${encodeURIComponent(v)}`,
  VENDOR: (v) => `/vendors/${encodeURIComponent(v)}`,
  CAMPAIGN: (v) => `/campaigns/${encodeURIComponent(v)}`,
  ASSIGNMENT: (v) => `/assignments/${encodeURIComponent(v)}`,
  CONTENT: (v) => `/content/${encodeURIComponent(v)}`,
  PARTNER_REVIEW: (v) => `/partner-reviews/${encodeURIComponent(v)}`,
};

function isTargetRefShape(value: unknown): value is { targetType: string; targetRef: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.targetType === "string" && typeof v.targetRef === "string";
}

export function drilldownHrefFor(columnKey: string, value: ReportRowValue): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const build = REF_LINK_ROUTES[columnKey];
  return build ? build(value) : null;
}

// A section's own row shape is genuinely `unknown` (ReportResult.sections is Record<string, unknown>
// server-side - see types.ts - because at least one family, operations_attention, passes its raw
// source DTOs straight through rather than the flat scalar-only ReportRow shape every other family
// uses). This renders ANY cell value honestly without ever crashing the page: primitives as before,
// a TargetReference-shaped object as its type+ref (linked when the type maps to a real route), a
// short array of primitives joined, and anything else as a compact real JSON string - never a
// fabricated summary, never a silent drop.
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return NO_VALUE_TEXT;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString(DATE_LOCALE) : String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}$/.test(value)) return periodKeyLabel(value);
    // A full ISO-8601 timestamp (e.g. a raw source record's own createdAt/approvedAt field, passed
    // straight through a section row) - formatted the same fixed-locale way as the result's own
    // generatedAt/evidenceCutoff fields, never left as a raw machine string. An unrecognized shape
    // (a plain label, a ref, etc.) is returned verbatim, never guessed.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return formatDateTime(value);
    return value;
  }
  if (isTargetRefShape(value)) return `${humanizeKey(value.targetType).toUpperCase()} ${value.targetRef}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return NO_VALUE_TEXT;
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) return value.map((v) => formatCellValue(v)).join(", ");
    return `${value.length} item(s)`;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return NO_VALUE_TEXT;
    }
  }
  return String(value);
}

export function cellDrilldownHref(columnKey: string, value: unknown): string | null {
  if (isTargetRefShape(value)) {
    const build = TARGET_TYPE_ROUTES[value.targetType];
    return build ? build(value.targetRef) : null;
  }
  return drilldownHrefFor(columnKey, value as ReportRowValue);
}
