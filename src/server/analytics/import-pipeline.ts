import { normalizeContentUrl } from "@/server/content/publication-identity";
import { computeNormalizedIdentity } from "@/server/partners/identity";
import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { classifyChannelSnapshotSheet, mapChannelSnapshotRows, type ChannelSnapshotCandidateRow } from "./adapters/channel-snapshot-adapter";
import { classifyInstagramContentSheet, mapInstagramContentRows, type InstagramContentCandidateRow } from "./adapters/instagram-content-adapter";
import { classifyYoutubeContentSheet, mapYoutubeContentRows, type YoutubeContentCandidateRow } from "./adapters/youtube-content-adapter";
import { checkImportFileSafety } from "@/server/imports/file-safety";
import { matchContentSourceRow } from "./content-matcher";
import { sha256HexBuffer } from "./firestore";
import { matchPartnerAccountSourceRow } from "./partner-account-matcher";
import { parseWorkbookBuffer, type ParsedSheet } from "./xlsx-parser";
import {
  ANALYTICS_ROW_CLASSIFICATIONS,
  type AnalyticsContentSourceRecordDoc,
  type AnalyticsChannelSourceRecordDoc,
  type AnalyticsReportingPeriod,
  type AnalyticsRowClassification,
  type AnalyticsSheetInventoryEntry,
  type AnalyticsTargetKind,
} from "./types";

// Step 12A section 7-11: the ONE shared parse -> classify -> map ->
// normalize -> validate -> match pipeline function. Both dry-run and
// execute call this exact function (see import-service.ts) - there is
// never a second, independently-maintained matcher/validator. The only
// difference between the two modes is what import-service.ts does with
// the result afterward: dry-run discards it, execute commits it.

export class AnalyticsImportRejectedError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

export type ContentRecordFields = Omit<AnalyticsContentSourceRecordDoc, "uid" | "sourceRef" | "batchRef" | "createdAt" | "correctionRevision">;
export type ChannelRecordFields = Omit<AnalyticsChannelSourceRecordDoc, "uid" | "sourceRef" | "batchRef" | "createdAt" | "correctionRevision">;

export type PipelineRowOutcome = {
  classification: AnalyticsRowClassification;
  sheetName: string;
  sourceRowNumber: number;
  recordKind: "content" | "channel" | null;
  // The pre-hash identity key (see computeRowIdentityKey) - null only for
  // rows that never reach identity computation (missing_dependency) or
  // that reach it but supply no usable evidence at all (invalid).
  rowIdentityKeyRaw: string | null;
  content?: ContentRecordFields;
  channel?: ChannelRecordFields;
  ignoredColumns: string[];
};

export type AnalyticsImportPipelineInput = {
  targetKind: AnalyticsTargetKind;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
  reportingPeriod?: AnalyticsReportingPeriod | null;
  // Required (and only meaningful) for targetKind === "channel_account" -
  // the actor's own explicit platform selection, used only when a sheet
  // carries no per-row "Platform" column of its own. Never guessed.
  channelPlatform?: string | null;
};

export type ExistingRowLookup = (rowIdentityDocId: string) => Promise<{ exists: true; batchRef: string } | { exists: false }>;

export type AnalyticsImportPipelineResult = {
  totalRows: number;
  counts: Record<AnalyticsRowClassification, number>;
  sourceSheetInventory: AnalyticsSheetInventoryEntry[];
  safeErrorSummary: string[];
  rows: PipelineRowOutcome[];
  sourceHash: string;
  sourceExtension: string;
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).trim().toLowerCase();
}

function reportingPeriodKey(period: AnalyticsReportingPeriod | null | undefined): string {
  return period ? `${period.start}:${period.end}` : "none";
}

// Deterministic row identity - Section 10's own exact formula:
// sha256(batchTargetKind + normalizedPlatform + the row's own strongest
// matching key + reportingPeriod). This function returns the PRE-HASH
// key; firestore.ts's analyticsRowIdentityDocId hashes it into the
// actual doc id. Exported (not just used internally) so
// seed-analytics-data.ts's static fixtures compute their own
// rowIdentityKey via the exact same algorithm the live pipeline uses,
// rather than a second, potentially-drifting reimplementation.
export function computeRowIdentityKey(targetKind: AnalyticsTargetKind, platform: string, strongestKey: string, period: AnalyticsReportingPeriod | null | undefined): string {
  return `${targetKind}:${platform}:${strongestKey}:${reportingPeriodKey(period)}`;
}

function contentStrongestKey(row: { rawPostId: string | null; rawPostUrl: string | null }): string | null {
  if (row.rawPostId) return `id:${row.rawPostId.trim().toLowerCase()}`;
  if (row.rawPostUrl) return `url:${normalizeContentUrl(row.rawPostUrl)}`;
  return null;
}

async function buildContentRowOutcome(
  targetKind: AnalyticsTargetKind,
  row: InstagramContentCandidateRow | YoutubeContentCandidateRow,
  reportingPeriod: AnalyticsReportingPeriod | null,
): Promise<PipelineRowOutcome> {
  const platform = normalizePlatformIdentifier(row.platform);
  const strongest = contentStrongestKey(row);

  if (!strongest) {
    return {
      classification: "invalid",
      sheetName: row.sheetName,
      sourceRowNumber: row.sourceRowNumber,
      recordKind: "content",
      rowIdentityKeyRaw: null,
      ignoredColumns: row.ignoredColumns,
    };
  }

  const rowIdentityKeyRaw = computeRowIdentityKey(targetKind, platform, strongest, reportingPeriod);

  const contentMatch = await matchContentSourceRow({ platform, platformContentId: row.rawPostId, rawUrl: row.rawPostUrl });

  // Best-effort Partner Account enrichment - a SEPARATE resolution using
  // whatever identity evidence this content row happens to carry
  // (username only, ordinarily). Its own failure/ambiguity never blocks
  // or downgrades the Content match itself.
  let matchedPartnerAccountRef: string | null = null;
  if (row.rawUsername) {
    const accountMatch = await matchPartnerAccountSourceRow({ platform, platformAccountId: null, profileUrl: null, handle: row.rawUsername });
    if (accountMatch.matchState === "MATCHED") matchedPartnerAccountRef = accountMatch.matchedPartnerAccountRef;
  }

  const dateTimeSuppliedButUnparseable = Boolean(row.rawPostDateTime) && row.postDateTimeIso === null;
  const classification: AnalyticsRowClassification =
    contentMatch.matchState === "MATCHED" && dateTimeSuppliedButUnparseable ? "warning" : (contentMatch.matchState.toLowerCase() as AnalyticsRowClassification);

  const content: ContentRecordFields = {
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    platform,
    rowIdentityKey: rowIdentityKeyRaw,
    rawPostId: row.rawPostId,
    rawPostUrl: row.rawPostUrl,
    rawPostType: row.rawPostType,
    rawPostDateTime: row.rawPostDateTime,
    rawMediaUrl: row.rawMediaUrl,
    rawCaption: row.rawCaption,
    rawComments: row.rawComments,
    rawLikes: row.rawLikes,
    rawViews: row.rawViews,
    rawFollowers: row.rawFollowers,
    rawUsername: row.rawUsername,
    rawEngagement: row.rawEngagement,
    rawAccountOrChannelName: row.rawAccountOrChannelName,
    normalizedUrl: row.rawPostUrl ? normalizeContentUrl(row.rawPostUrl) : null,
    postDateTimeIso: row.postDateTimeIso,
    comments: row.comments,
    likes: row.likes,
    views: row.views,
    profileFollowers: row.profileFollowers,
    engagement: row.engagement,
    reportingPeriod: reportingPeriod ?? null,
    matchState: contentMatch.matchState,
    matchEvidence: contentMatch.matchEvidence,
    matchedContentRef: contentMatch.matchedContentRef,
    matchedAssignmentRef: contentMatch.matchedAssignmentRef,
    matchedCampaignRef: contentMatch.matchedCampaignRef,
    matchedPartnerRef: contentMatch.matchedPartnerRef,
    matchedPartnerAccountRef,
    ownerUid: contentMatch.ownerUid,
    regionIds: contentMatch.regionIds,
    teamIds: contentMatch.teamIds,
  };

  return {
    classification,
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    recordKind: "content",
    rowIdentityKeyRaw,
    content,
    ignoredColumns: row.ignoredColumns,
  };
}

async function buildChannelRowOutcome(targetKind: AnalyticsTargetKind, row: ChannelSnapshotCandidateRow, reportingPeriod: AnalyticsReportingPeriod | null): Promise<PipelineRowOutcome> {
  const platform = normalizePlatformIdentifier(row.platform);
  const strongest = computeNormalizedIdentity({ platform, platformAccountId: row.rawPlatformAccountId, profileUrl: row.rawProfileUrl, handle: row.rawUsername });

  if (!strongest) {
    return {
      classification: "invalid",
      sheetName: row.sheetName,
      sourceRowNumber: row.sourceRowNumber,
      recordKind: "channel",
      rowIdentityKeyRaw: null,
      ignoredColumns: row.ignoredColumns,
    };
  }

  const rowIdentityKeyRaw = computeRowIdentityKey(targetKind, platform, strongest, reportingPeriod);
  const match = await matchPartnerAccountSourceRow({ platform, platformAccountId: row.rawPlatformAccountId, profileUrl: row.rawProfileUrl, handle: row.rawUsername });

  const channel: ChannelRecordFields = {
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    platform,
    rowIdentityKey: rowIdentityKeyRaw,
    rawUsername: row.rawUsername,
    rawProfileUrl: row.rawProfileUrl,
    rawPlatformAccountId: row.rawPlatformAccountId,
    rawFollowers: row.rawFollowers,
    rawAccountOrChannelName: row.rawAccountOrChannelName,
    normalizedProfileUrl: row.normalizedProfileUrl,
    profileFollowers: row.profileFollowers,
    reportingPeriod: reportingPeriod ?? null,
    matchState: match.matchState,
    matchEvidence: match.matchEvidence,
    matchedPartnerRef: match.matchedPartnerRef,
    matchedPartnerAccountRef: match.matchedPartnerAccountRef,
    ownerUid: match.ownerUid,
    regionIds: match.regionIds,
    teamIds: match.teamIds,
  };

  return {
    classification: match.matchState.toLowerCase() as AnalyticsRowClassification,
    sheetName: row.sheetName,
    sourceRowNumber: row.sourceRowNumber,
    recordKind: "channel",
    rowIdentityKeyRaw,
    channel,
    ignoredColumns: row.ignoredColumns,
  };
}

// Classifies one parsed sheet against the adapters valid for the chosen
// targetKind, in a fixed registration order (content: Instagram then
// YouTube). The first adapter that recognizes sufficient headers wins
// the sheet - a sheet is never split across two adapters, and is never
// forced into a specific name.
function classifySheetAdapter(targetKind: AnalyticsTargetKind, sheet: ParsedSheet): { recognizedAs: "campaign_content" | "channel_account" | "unrecognized"; unsupportedHeaders: string[] } {
  if (targetKind === "campaign_content") {
    const instagram = classifyInstagramContentSheet(sheet.headers);
    if (instagram.isRecognized) return { recognizedAs: "campaign_content", unsupportedHeaders: instagram.unsupportedHeaders };
    const youtube = classifyYoutubeContentSheet(sheet.headers);
    if (youtube.isRecognized) return { recognizedAs: "campaign_content", unsupportedHeaders: youtube.unsupportedHeaders };
    return { recognizedAs: "unrecognized", unsupportedHeaders: [] };
  }

  const channel = classifyChannelSnapshotSheet(sheet.headers);
  if (channel.isRecognized) return { recognizedAs: "channel_account", unsupportedHeaders: channel.unsupportedHeaders };
  return { recognizedAs: "unrecognized", unsupportedHeaders: [] };
}

export async function runAnalyticsImportPipeline(
  input: AnalyticsImportPipelineInput,
  checkExistingRow: ExistingRowLookup,
  currentBatchRef: string,
): Promise<AnalyticsImportPipelineResult> {
  const safetyCheck = checkImportFileSafety({ filename: input.filename, mimeType: input.mimeType, sizeBytes: input.fileBuffer.byteLength, buffer: input.fileBuffer });
  if (!safetyCheck.ok) throw new AnalyticsImportRejectedError(safetyCheck.reasonCode, safetyCheck.message);

  const parsed = parseWorkbookBuffer(input.fileBuffer);
  if (!parsed.ok) throw new AnalyticsImportRejectedError(parsed.reasonCode, parsed.message);

  if (input.targetKind === "channel_account" && !input.channelPlatform) {
    throw new AnalyticsImportRejectedError("MISSING_CHANNEL_PLATFORM", "A channel_account import requires an explicit platform selection.");
  }

  const sourceHash = sha256HexBuffer(input.fileBuffer);
  const sourceExtension = extensionOf(input.filename);
  const reportingPeriod = input.reportingPeriod ?? null;

  const sourceSheetInventory: AnalyticsSheetInventoryEntry[] = [];
  const safeErrorSummary: string[] = [];
  const rows: PipelineRowOutcome[] = [];

  for (const sheet of parsed.sheets) {
    const { recognizedAs, unsupportedHeaders } = classifySheetAdapter(input.targetKind, sheet);
    sourceSheetInventory.push({ sheetName: sheet.sheetName, rowCount: sheet.rows.length, recognizedAs });

    if (unsupportedHeaders.length > 0) {
      safeErrorSummary.push(`Sheet "${sheet.sheetName}": ignored unsupported column(s) ${unsupportedHeaders.join(", ")}.`);
    }

    if (recognizedAs === "unrecognized") {
      for (let i = 0; i < sheet.rows.length; i++) {
        rows.push({ classification: "missing_dependency", sheetName: sheet.sheetName, sourceRowNumber: i + 2, recordKind: null, rowIdentityKeyRaw: null, ignoredColumns: [] });
      }
      continue;
    }

    if (input.targetKind === "campaign_content") {
      const instagram = classifyInstagramContentSheet(sheet.headers);
      const candidates = instagram.isRecognized
        ? mapInstagramContentRows(sheet.sheetName, sheet.rows, sheet.headers)
        : mapYoutubeContentRows(sheet.sheetName, sheet.rows, sheet.headers);
      for (const candidate of candidates) {
        rows.push(await buildContentRowOutcome(input.targetKind, candidate, reportingPeriod));
      }
    } else {
      const candidates = mapChannelSnapshotRows(sheet.sheetName, input.channelPlatform!, sheet.rows, sheet.headers);
      for (const candidate of candidates) {
        rows.push(await buildChannelRowOutcome(input.targetKind, candidate, reportingPeriod));
      }
    }
  }

  // Duplicate/unchanged resolution - checked AFTER matching (matching is
  // still performed for every row, per the dry-run contract's own "every
  // step including matching" requirement), but the row's FINAL
  // classification is downgraded to duplicate/unchanged when its
  // identity key already belongs to an existing committed record.
  for (const row of rows) {
    if (!row.rowIdentityKeyRaw) continue;
    if (row.classification === "invalid" || row.classification === "missing_dependency") continue;

    const existing = await checkExistingRow(row.rowIdentityKeyRaw);
    if (!existing.exists) continue;
    row.classification = existing.batchRef === currentBatchRef ? "unchanged" : "duplicate";
  }

  const counts = Object.fromEntries(ANALYTICS_ROW_CLASSIFICATIONS.map((c) => [c, 0])) as Record<AnalyticsRowClassification, number>;
  for (const row of rows) counts[row.classification] += 1;

  return { totalRows: rows.length, counts, sourceSheetInventory, safeErrorSummary, rows, sourceHash, sourceExtension };
}
