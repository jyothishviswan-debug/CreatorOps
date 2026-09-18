import { parseSupportedDateTime, parseSupportedMetric, type AnalyticsMetricId } from "../metric-registry";
import { classifyHeaders, fieldValueGetter, toSafeString, type RawSheetRow } from "./shared";

// Step 12A section 6: YouTube content adapter - same discipline as
// instagram-content-adapter.ts, its own distinct alias table (YouTube
// exports use "Video ID"/"Video URL"/"Channel" rather than Instagram's
// "Post ID"/"Post URL"/"Partner" wording, even though both map to the
// exact same canonical metric-registry field ids).
export const YOUTUBE_CONTENT_HEADER_ALIASES: Record<AnalyticsMetricId, string[]> = {
  postId: ["Platform Content ID", "Video ID", "Content ID"],
  postUrl: ["Post URL", "Video URL", "Link to Video"],
  postDateTime: ["Post Date", "Publish Date", "Upload Date", "Published Date"],
  postType: ["Post Type", "Video Type", "Format"],
  postMediaUrl: ["Media URL", "Thumbnail URL"],
  postCaption: ["Title", "Video Title", "Description"],
  comments: ["Comments", "Comment Count", "# Comments"],
  likes: ["Likes", "Like Count", "# Likes"],
  views: ["Views", "View Count", "Video Views"],
  profileFollowers: ["Subscribers", "Subscriber Count", "Followers"],
  accountUsername: ["Partner Account", "Creator Account", "Channel Handle", "Channel Username"],
  engagement: ["Engagement", "Engagement Rate"],
  accountOrChannelName: ["Partner", "Creator", "Channel", "Channel Name"],
};

export type YoutubeContentCandidateRow = {
  sheetName: string;
  sourceRowNumber: number;
  platform: "youtube";
  rawPostId: string | null;
  rawPostUrl: string | null;
  rawPostType: string | null;
  rawPostDateTime: string | null;
  rawMediaUrl: string | null;
  rawCaption: string | null;
  rawComments: string | null;
  rawLikes: string | null;
  rawViews: string | null;
  rawFollowers: string | null;
  rawUsername: string | null;
  rawEngagement: string | null;
  rawAccountOrChannelName: string | null;
  postDateTimeIso: string | null;
  comments: number | null;
  likes: number | null;
  views: number | null;
  profileFollowers: number | null;
  engagement: number | null;
  ignoredColumns: string[];
};

export function classifyYoutubeContentSheet(headers: string[]): { isRecognized: boolean; recognizedHeaderCount: number; unsupportedHeaders: string[]; unrecognizedHeaders: string[] } {
  const classification = classifyHeaders(headers, YOUTUBE_CONTENT_HEADER_ALIASES);
  const recognizedFieldIds = new Set(classification.recognized.values());
  const isRecognized = recognizedFieldIds.has("postId") || recognizedFieldIds.has("postUrl");
  return {
    isRecognized,
    recognizedHeaderCount: classification.recognized.size,
    unsupportedHeaders: [...classification.unsupported.keys()],
    unrecognizedHeaders: classification.unrecognized,
  };
}

export function mapYoutubeContentRows(sheetName: string, rows: RawSheetRow[], headers: string[]): YoutubeContentCandidateRow[] {
  const classification = classifyHeaders(headers, YOUTUBE_CONTENT_HEADER_ALIASES);

  return rows.map((row, index) => {
    const get = fieldValueGetter(classification.recognized, row);

    return {
      sheetName,
      sourceRowNumber: index + 2,
      platform: "youtube",
      rawPostId: toSafeString(get("postId")),
      rawPostUrl: toSafeString(get("postUrl")),
      rawPostType: toSafeString(get("postType")),
      rawPostDateTime: toSafeString(get("postDateTime")),
      rawMediaUrl: toSafeString(get("postMediaUrl")),
      rawCaption: toSafeString(get("postCaption")),
      rawComments: toSafeString(get("comments")),
      rawLikes: toSafeString(get("likes")),
      rawViews: toSafeString(get("views")),
      rawFollowers: toSafeString(get("profileFollowers")),
      rawUsername: toSafeString(get("accountUsername")),
      rawEngagement: toSafeString(get("engagement")),
      rawAccountOrChannelName: toSafeString(get("accountOrChannelName")),
      postDateTimeIso: parseSupportedDateTime(get("postDateTime")),
      comments: parseSupportedMetric(get("comments")),
      likes: parseSupportedMetric(get("likes")),
      views: parseSupportedMetric(get("views")),
      profileFollowers: parseSupportedMetric(get("profileFollowers")),
      engagement: parseSupportedMetric(get("engagement")),
      ignoredColumns: [...classification.unsupported.keys()],
    };
  });
}
