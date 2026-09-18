// Step 12B: pure, unit-testable row-label composition for the Data
// Explorer table/cards - never renders a raw ref, always falls back to a
// safe, truthful derived label when a record isn't MATCHED or its
// resolved label hasn't arrived yet.
import { platformLabel, reportingPeriodLabel } from "./format";
import type { AnalyticsLabelMaps } from "@/server/analytics/label-resolution";

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

export function sourceLabel(record: { batchRef: string; sheetName: string; sourceRowNumber: number }, labels: AnalyticsLabelMaps = EMPTY_LABELS): string {
  const filename = labels.batches[record.batchRef] ?? "Import batch";
  return `${filename} · sheet ${record.sheetName} · row ${record.sourceRowNumber}`;
}
