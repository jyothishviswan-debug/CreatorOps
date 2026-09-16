import type { ScopeSummaryDto } from "@/server/authz/client-dto";

// A fixed locale, never `undefined` - `undefined` resolves to the
// running environment's own default locale, which differs between the
// Node.js server (SSR) and the browser (hydration), producing two
// different formatted strings for the exact same instant and a React
// hydration mismatch. "en-GB" also matches this app's existing date
// style elsewhere (e.g. "14 Sep 2026 · 10:24").
const DATE_LOCALE = "en-GB";

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric" });
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(DATE_LOCALE, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const OPERATION_LABELS: Record<string, string> = {
  "user.create": "User created",
  "user.update": "Profile updated",
  "user.role_change": "Role changed",
  "user.activate": "User activated",
  "user.deactivate": "User deactivated",
  "scope_grant.add": "Scope grant added",
  "scope_grant.remove": "Scope grant removed",
  "sensitive_grant.add": "Sensitive category added",
  "sensitive_grant.remove": "Sensitive category removed",
};

export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation;
}

// A compact, safe summary of an audit event's before/after metadata -
// never renders raw ids or anything not already present in the safe
// metadata the server chose to record.
export function changeSummary(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!before && !after) return "—";
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  if (keys.size === 0) return "—";
  const parts: string[] = [];
  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    if (from === undefined) parts.push(`${key}: ${formatValue(to)}`);
    else if (to === undefined) parts.push(`${key} removed`);
    else parts.push(`${key}: ${formatValue(from)} → ${formatValue(to)}`);
  }
  return parts.length > 0 ? parts.join("; ") : "—";
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function formatActionLabel(action: string): string {
  return action
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

// A flat list of human-readable scope chips from the server-returned
// ScopeSummaryDto - display only, never re-derives an access decision.
export function scopeChips(scope: ScopeSummaryDto): { label: string; kind: "global" | "self" | "region" | "team" | "partner" | "campaign" | "dataset" | "account" }[] {
  const chips: { label: string; kind: "global" | "self" | "region" | "team" | "partner" | "campaign" | "dataset" | "account" }[] = [];
  if (scope.global) chips.push({ label: "Global", kind: "global" });
  if (scope.self) chips.push({ label: "Self", kind: "self" });
  for (const region of scope.regions) chips.push({ label: `Region: ${region}`, kind: "region" });
  for (const team of scope.teams) chips.push({ label: `Team: ${team}`, kind: "team" });
  for (const partner of scope.partners) chips.push({ label: `Partner: ${partner}`, kind: "partner" });
  for (const campaign of scope.campaigns) chips.push({ label: `Campaign: ${campaign}`, kind: "campaign" });
  for (const dataset of scope.analyticsDatasets) chips.push({ label: `Dataset: ${dataset}`, kind: "dataset" });
  for (const account of scope.analyticsAccounts) chips.push({ label: `Analytics account: ${account}`, kind: "account" });
  if (scope.explicitRecordCount > 0) chips.push({ label: `${scope.explicitRecordCount} explicit record grant${scope.explicitRecordCount === 1 ? "" : "s"}`, kind: "global" });
  return chips;
}
