// Best-effort platform/handle derivation from a profile URL - "may be
// derived when safe but must remain correctable" (Step 6B). Never throws
// on a malformed URL; returns {} when nothing can be safely inferred.
//
// Some platforms put a literal path keyword before the real handle
// (youtube.com/channel/<id>, youtube.com/c/<name>,
// linkedin.com/in/<name>, linkedin.com/company/<name>) - taking the
// first path segment unconditionally would capture that keyword
// ("channel", "in", ...) as the handle instead of the actual identifier.
// `skipSegments` lists the keywords to skip past for that platform.
const PLATFORM_HOSTS: { pattern: RegExp; label: string; skipSegments?: string[] }[] = [
  { pattern: /instagram\.com$/i, label: "Instagram" },
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
  const segment = segments[0] && match?.skipSegments?.includes(segments[0].toLowerCase()) ? segments[1] : segments[0];
  const handle = segment ? segment.replace(/^@/, "") : undefined;

  return { ...(match ? { platform: match.label } : {}), ...(handle ? { handle } : {}) };
}
