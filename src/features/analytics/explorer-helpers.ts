// Step 12B: pure, unit-testable row-label composition for the Data
// Explorer table/cards - never renders a raw ref, always falls back to a
// safe, truthful derived label when a record isn't MATCHED or its
// resolved label hasn't arrived yet.
import { platformLabel, reportingPeriodLabel } from "./format";
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

// The platforms the Explorer's "Filter platform" select offers - the single
// list both the select and the ?platform= deep-link parser below use, so a
// deep link can never select a value the select has no option for.
export const EXPLORER_PLATFORM_OPTIONS = ["instagram", "youtube", "tiktok"] as const;

// Step 12D: safely parses the Explorer's ?platform= query parameter. The
// stored source records only ever carry the NORMALIZED platform id, so the
// raw value is normalized with the shared normalizePlatformIdentifier
// (trim + lowercase) before it is used as a server filter or shown in the
// select. Anything that is not exactly one string naming an offered
// platform (repeated params, empty/whitespace, unknown or garbage values) is
// neutralized to `undefined` - i.e. no platform filter - never passed through.
export function parseExplorerPlatformParam(raw: unknown): (typeof EXPLORER_PLATFORM_OPTIONS)[number] | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = normalizePlatformIdentifier(raw);
  return (EXPLORER_PLATFORM_OPTIONS as readonly string[]).includes(normalized) ? (normalized as (typeof EXPLORER_PLATFORM_OPTIONS)[number]) : undefined;
}

// Step 12E: safely parses the Explorer's ?partnerRef= / ?partnerAccountRef=
// deep-link parameters. Each is passed straight to the server filter
// (matchedPartnerRef / matchedPartnerAccountRef) where the accepted, scoped
// planner enforces the actor's scope BEFORE retrieval - a ref the actor cannot
// see simply yields no rows. Only exactly ONE non-empty, bounded, printable
// string is accepted (repeated params, empty/whitespace, over-long or
// control-character values are neutralized to `undefined` = no filter).
export const MAX_EXPLORER_REF_PARAM_LENGTH = 200;
export function parseExplorerRefParam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_EXPLORER_REF_PARAM_LENGTH) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

export type ExplorerContentRow = {
  platform: string;
  matchState: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  reportingPeriod: { start: string; end: string } | null;
  matchedContentRef: string | null;
  matchedCampaignRef: string | null;
  batchRef: string;
  sheetName: string;
  sourceRowNumber: number;
};

export type ExplorerChannelRow = {
  platform: string;
  matchState: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  reportingPeriod: { start: string; end: string } | null;
  matchedPartnerRef: string | null;
  matchedPartnerAccountRef: string | null;
  rawUsername: string | null;
  batchRef: string;
  sheetName: string;
  sourceRowNumber: number;
};

function dedupe(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

export function collectContentLabelRefs(records: ExplorerContentRow[]): { contentRefs: string[]; campaignRefs: string[]; batchRefs: string[] } {
  return {
    contentRefs: dedupe(records.map((r) => r.matchedContentRef)),
    campaignRefs: dedupe(records.map((r) => r.matchedCampaignRef)),
    batchRefs: dedupe(records.map((r) => r.batchRef)),
  };
}

export function collectChannelLabelRefs(records: ExplorerChannelRow[]): { partnerRefs: string[]; partnerAccountRefs: string[]; batchRefs: string[] } {
  return {
    partnerRefs: dedupe(records.map((r) => r.matchedPartnerRef)),
    partnerAccountRefs: dedupe(records.map((r) => r.matchedPartnerAccountRef)),
    batchRefs: dedupe(records.map((r) => r.batchRef)),
  };
}

const EMPTY_LABELS: AnalyticsLabelMaps = { content: {}, campaigns: {}, partners: {}, partnerAccounts: {}, batches: {} };

export function contentRecordLabel(record: ExplorerContentRow, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  if (record.matchState === "MATCHED" && record.matchedContentRef) return labels.content[record.matchedContentRef] ?? "Matched content";
  return `${platformLabel(record.platform)} · ${reportingPeriodLabel(record.reportingPeriod)}`;
}

export function channelRecordLabel(record: ExplorerChannelRow, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  if (record.matchState === "MATCHED" && record.matchedPartnerAccountRef) return labels.partnerAccounts[record.matchedPartnerAccountRef] ?? "Matched account";
  return `${platformLabel(record.platform)} · @${record.rawUsername ?? "unknown handle"}`;
}

export function contentScopeLabel(record: ExplorerContentRow, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  if (!record.matchedCampaignRef) return "—";
  return labels.campaigns[record.matchedCampaignRef] ?? "—";
}

export function channelScopeLabel(record: ExplorerChannelRow, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  if (!record.matchedPartnerRef) return "—";
  return labels.partners[record.matchedPartnerRef] ?? "—";
}

// Step 12E: the Partner Analytics link for a channel row's Partner label - only
// when the server resolved one (partners feature + Partner Record Scope); else
// `null` and the label renders as plain text.
export function channelPartnerAnalyticsHref(record: ExplorerChannelRow, labels: AnalyticsLabelMaps = EMPTY_LABELS): string | null {
  if (!record.matchedPartnerRef) return null;
  return labels.partnerAnalyticsLinks?.[record.matchedPartnerRef] ?? null;
}

export function sourceLabel(record: { batchRef: string; sheetName: string; sourceRowNumber: number }, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  const filename = labels.batches[record.batchRef] ?? "Import batch";
  return `${filename} · sheet ${record.sheetName} · row ${record.sourceRowNumber}`;
}
