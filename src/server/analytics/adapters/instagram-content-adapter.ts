import { parseSupportedDateTime, parseSupportedMetric, type AnalyticsMetricId } from "../metric-registry";
import { classifyHeaders, fieldValueGetter, toSafeString, type RawSheetRow } from "./shared";

// Step 12A section 6: Instagram content adapter. Recognizes the accepted
// header aliases below (case-insensitive, whitespace-tolerant - see
// shared.ts's normalizeHeaderKey), maps each to its canonical
// metric-registry field id, leaves every unrecognized header alone, and
// classifies a sheet as belonging to this adapter only when the actor
// has explicitly chosen the "campaign_content" import target AND the
// sheet carries a sufficient/explicit identity dimension of its own
// (postId or postUrl) - never a forced exact sheet name, never guessed
// from platform alone.
export const INSTAGRAM_CONTENT_HEADER_ALIASES: Record<AnalyticsMetricId, string[]> = {
  postId: ["Platform Content ID", "Post ID", "Media ID"],
  postUrl: ["Post URL", "Link to Post", "Permalink"],
  postDateTime: ["Post Date", "Date Posted", "Published Date", "Post Date/Time"],
  postType: ["Post Type", "Media Type", "Content Type"],
  postMediaUrl: ["Media URL", "Image URL", "Thumbnail URL"],
  postCaption: ["Caption", "Post Caption", "Description"],
  comments: ["Comments", "Comment Count", "# Comments"],
  likes: ["Likes", "Like Count", "# Likes"],
  views: ["Views", "Video Views", "Play Count", "View Count"],
  profileFollowers: ["Followers", "Follower Count", "Followers at Post"],
  accountUsername: ["Partner Account", "Creator Account", "Username", "Handle", "Account Username"],
  engagement: ["Engagement", "Engagement Rate"],
  accountOrChannelName: ["Partner", "Creator", "Account Name", "Creator Name"],
};

export type InstagramContentCandidateRow = {
  sheetName: string;
  sourceRowNumber: number;
  platform: "instagram";
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
  ignoredColumns: string[]; // headers recognized as unsupported metrics, dropped
};

export function classifyInstagramContentSheet(headers: string[]): { isRecognized: boolean; recognizedHeaderCount: number; unsupportedHeaders: string[]; unrecognizedHeaders: string[] } {
  const classification = classifyHeaders(headers, INSTAGRAM_CONTENT_HEADER_ALIASES);
  const recognizedFieldIds = new Set(classification.recognized.values());
  const isRecognized = recognizedFieldIds.has("postId") || recognizedFieldIds.has("postUrl");
  return {
    isRecognized,
    recognizedHeaderCount: classification.recognized.size,
    unsupportedHeaders: [...classification.unsupported.keys()],
    unrecognizedHeaders: classification.unrecognized,
  };
}

export function mapInstagramContentRows(sheetName: string, rows: RawSheetRow[], headers: string[]): InstagramContentCandidateRow[] {
  const classification = classifyHeaders(headers, INSTAGRAM_CONTENT_HEADER_ALIASES);

  return rows.map((row, index) => {
    const get = fieldValueGetter(classification.recognized, row);
    const rawPostDateTime = toSafeString(get("postDateTime"));
    const rawComments = toSafeString(get("comments"));
    const rawLikes = toSafeString(get("likes"));
    const rawViews = toSafeString(get("views"));
    const rawFollowers = toSafeString(get("profileFollowers"));
    const rawEngagement = toSafeString(get("engagement"));

    return {
      sheetName,
      sourceRowNumber: index + 2, // header is row 1, data starts at row 2
      platform: "instagram",
      rawPostId: toSafeString(get("postId")),
      rawPostUrl: toSafeString(get("postUrl")),
      rawPostType: toSafeString(get("postType")),
      rawPostDateTime,
      rawMediaUrl: toSafeString(get("postMediaUrl")),
      rawCaption: toSafeString(get("postCaption")),
      rawComments,
      rawLikes,
      rawViews,
      rawFollowers,
      rawUsername: toSafeString(get("accountUsername")),
      rawEngagement,
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
