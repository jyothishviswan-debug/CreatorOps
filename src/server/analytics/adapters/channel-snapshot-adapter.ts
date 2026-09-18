import { parseSupportedMetric } from "../metric-registry";
import { classifyHeaders, fieldValueGetter, toSafeString, type RawSheetRow } from "./shared";

// Step 12A section 6: the channel/account snapshot adapter - one shared
// classifier for BOTH platforms (Instagram/YouTube), since a channel
// snapshot row's own shape (identity + follower count + display name) is
// identical regardless of platform; only the `platform` value on each row
// differs, and that is supplied by the actor's own explicit platform
// selection at import time (Section 6's "platform identity stays an open
// string" instruction - never guessed from header content). Recognizes
// three distinct IDENTITY dimensions (platformAccountId, profileUrl,
// handle) - deliberately NOT part of the metric-registry's own
// AnalyticsMetricId union, since they are matching keys, not analytics
// metrics - plus the two metric-registry fields that genuinely apply to
// an account snapshot (profileFollowers, accountOrChannelName).
export type ChannelSnapshotFieldId = "platform" | "platformAccountId" | "profileUrl" | "handle" | "profileFollowers" | "accountOrChannelName";

export const CHANNEL_SNAPSHOT_HEADER_ALIASES: Record<ChannelSnapshotFieldId, string[]> = {
  // A sheet's own "Platform" column, when present, is per-row authority -
  // never guessed from any other column's content. When the sheet has no
  // such column at all, mapChannelSnapshotRows falls back to the actor's
  // own explicit import-time platform selection (see import-pipeline.ts) -
  // still never guessed, just supplied at a different, coarser level.
  platform: ["Platform"],
  platformAccountId: ["Platform Account ID", "Channel ID", "Account ID"],
  profileUrl: ["Profile URL", "Channel URL", "Account URL"],
  handle: ["Partner Account", "Creator Account", "Username", "Handle", "Channel Handle", "Channel Username"],
  profileFollowers: ["Followers", "Follower Count", "Subscribers", "Subscriber Count"],
  accountOrChannelName: ["Partner", "Creator", "Account Name", "Channel Name", "Creator Name"],
};

export type ChannelSnapshotCandidateRow = {
  sheetName: string;
  sourceRowNumber: number;
  platform: string;
  rawUsername: string | null; // "handle" dimension - kept under the same field name the schema uses
  rawProfileUrl: string | null;
  rawPlatformAccountId: string | null;
  rawFollowers: string | null;
  rawAccountOrChannelName: string | null;
  normalizedProfileUrl: string | null;
  profileFollowers: number | null;
  ignoredColumns: string[];
};

export function classifyChannelSnapshotSheet(headers: string[]): { isRecognized: boolean; recognizedHeaderCount: number; unsupportedHeaders: string[]; unrecognizedHeaders: string[] } {
  const classification = classifyHeaders(headers, CHANNEL_SNAPSHOT_HEADER_ALIASES);
  const recognizedFieldIds = new Set(classification.recognized.values());
  const isRecognized = recognizedFieldIds.has("platformAccountId") || recognizedFieldIds.has("profileUrl") || recognizedFieldIds.has("handle");
  return {
    isRecognized,
    recognizedHeaderCount: classification.recognized.size,
    unsupportedHeaders: [...classification.unsupported.keys()],
    unrecognizedHeaders: classification.unrecognized,
  };
}

function normalizeProfileUrlForStorage(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    url.pathname = path;
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// `defaultPlatform` is the actor's own explicit import-time platform
// selection - used only for a row whose sheet carries no per-row
// "Platform" column of its own. Never guessed from handle/URL content.
export function mapChannelSnapshotRows(sheetName: string, defaultPlatform: string, rows: RawSheetRow[], headers: string[]): ChannelSnapshotCandidateRow[] {
  const classification = classifyHeaders(headers, CHANNEL_SNAPSHOT_HEADER_ALIASES);

  return rows.map((row, index) => {
    const get = fieldValueGetter(classification.recognized, row);
    const rawProfileUrl = toSafeString(get("profileUrl"));
    const rowPlatform = toSafeString(get("platform")) ?? defaultPlatform;

    return {
      sheetName,
      sourceRowNumber: index + 2,
      platform: rowPlatform,
      rawUsername: toSafeString(get("handle")),
      rawProfileUrl,
      rawPlatformAccountId: toSafeString(get("platformAccountId")),
      rawFollowers: toSafeString(get("profileFollowers")),
      rawAccountOrChannelName: toSafeString(get("accountOrChannelName")),
      normalizedProfileUrl: normalizeProfileUrlForStorage(rawProfileUrl),
      profileFollowers: parseSupportedMetric(get("profileFollowers")),
      ignoredColumns: [...classification.unsupported.keys()],
    };
  });
}
