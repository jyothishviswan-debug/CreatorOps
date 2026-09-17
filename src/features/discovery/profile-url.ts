// Best-effort platform/handle derivation from a profile URL - "may be
// derived when safe but must remain correctable" (Step 6B). Never throws
// on a malformed URL; returns {} when nothing can be safely inferred.
//
// Some platforms put a literal path keyword before the real handle
// (youtube.com/channel/<id>, youtube.com/c/<name>,
// linkedin.com/in/<name>, linkedin.com/company/<name>,
// instagram.com/stories/<username>/...) - taking the first path segment
// unconditionally would capture that keyword ("channel", "in",
// "stories", ...) as the handle instead of the actual identifier.
// `skipSegments` lists the keywords to skip past for that platform.
//
// A second, distinct case: some paths aren't a profile at all - they're
// a specific POST/story/reel permalink (instagram.com/reel/<shortcode>,
// instagram.com/p/<shortcode>, .../tv/<shortcode>). The segment after
// the keyword there is a post id, never a username, so unlike
// `skipSegments` there is no real handle anywhere in the URL to fall
// back to - `noHandleSegments` suppresses handle capture entirely
// rather than reporting that post id (or the keyword itself) as if it
// were one.
const PLATFORM_HOSTS: { pattern: RegExp; label: string; skipSegments?: string[]; noHandleSegments?: string[] }[] = [
  { pattern: /instagram\.com$/i, label: "Instagram", skipSegments: ["stories"], noHandleSegments: ["p", "reel", "reels", "tv", "explore", "accounts", "direct"] },
  { pattern: /(youtube\.com|youtu\.be)$/i, label: "YouTube", skipSegments: ["channel", "c", "user"] },
  { pattern: /tiktok\.com$/i, label: "TikTok" },
  { pattern: /(twitter\.com|x\.com)$/i, label: "X (Twitter)" },
  { pattern: /facebook\.com$/i, label: "Facebook" },
  { pattern: /linkedin\.com$/i, label: "LinkedIn", skipSegments: ["in", "company"] },
];

export function deriveFromProfileUrl(rawUrl: string): { platform?: string; handle?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return {};
  }

  const match = PLATFORM_HOSTS.find((p) => p.pattern.test(url.hostname.replace(/^www\./, "")));
  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();

  let handle: string | undefined;
  if (first && match?.noHandleSegments?.includes(first)) {
    handle = undefined;
  } else {
    const segment = first && match?.skipSegments?.includes(first) ? segments[1] : segments[0];
    handle = segment ? segment.replace(/^@/, "") : undefined;
  }

  return { ...(match ? { platform: match.label } : {}), ...(handle ? { handle } : {}) };
}
