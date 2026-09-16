// Best-effort platform/handle derivation from a profile URL - "may be
// derived when safe but must remain correctable" (Step 6B). Never throws
// on a malformed URL; returns {} when nothing can be safely inferred.
const PLATFORM_HOSTS: { pattern: RegExp; label: string }[] = [
  { pattern: /instagram\.com$/i, label: "Instagram" },
  { pattern: /(youtube\.com|youtu\.be)$/i, label: "YouTube" },
  { pattern: /tiktok\.com$/i, label: "TikTok" },
  { pattern: /(twitter\.com|x\.com)$/i, label: "X (Twitter)" },
  { pattern: /facebook\.com$/i, label: "Facebook" },
  { pattern: /linkedin\.com$/i, label: "LinkedIn" },
];

export function deriveFromProfileUrl(rawUrl: string): { platform?: string; handle?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return {};
  }

  const platform = PLATFORM_HOSTS.find((p) => p.pattern.test(url.hostname.replace(/^www\./, "")))?.label;
  const segment = url.pathname.split("/").filter(Boolean)[0];
  const handle = segment ? segment.replace(/^@/, "") : undefined;

  return { ...(platform ? { platform } : {}), ...(handle ? { handle } : {}) };
}
