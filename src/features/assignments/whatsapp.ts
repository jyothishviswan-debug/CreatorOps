import { isHttpUrl } from "@/server/shared/http-url";
import type { CampaignResource } from "@/server/campaigns/types";
import { platformLabel } from "./format";

// Finding #38: this message body is a recipient-facing plain-text
// context, never HTML/markdown - a resource label with an embedded
// newline or control character could otherwise inject a fake extra
// message line (or make a label read as if it were its own "link" line).
// Strips newlines/control characters and collapses runs of whitespace;
// the URL itself is validated separately via isHttpUrl, never touched by
// this function.
function sanitizeMessageLabel(value: string): string {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

// Finding #38: the one canonical, deterministic "Resources" section for
// the share message - LINK/UPLOAD only ever contribute their own
// already-safe, already-validated `url` (never an internal storage
// locator/fileId - Campaign Resources never store one at all); TEXT
// never fabricates a URL, exactly as required. Sorted by `addedAt` (a
// resource's own real ordering, always present) with `resourceRef` as a
// stable tie-breaker - the same regardless of how many times this is
// called for the same Campaign, so a re-share is deterministic.
// Deduplicates on the exact validated URL (a caller adding the same real
// link twice should still produce one line, not two). Bounded to the
// first 30 (Campaign resources are themselves capped at 50 - this stays
// a safe, readable list length, never an unbounded message).
const MAX_SHARED_RESOURCE_LINKS = 30;
function buildResourceLines(resources: readonly CampaignResource[]): string[] {
  const seen = new Set<string>();
  const rows: { label: string; url: string }[] = [];
  const sorted = [...resources].sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.resourceRef.localeCompare(b.resourceRef));
  for (const resource of sorted) {
    if (resource.type === "TEXT") continue; // never fabricate a URL for a text-only resource
    if (!resource.url || !isHttpUrl(resource.url)) continue; // an unavailable/invalid URL is safely omitted, not shown broken
    if (seen.has(resource.url)) continue; // duplicate canonical URL, deduped
    seen.add(resource.url);
    rows.push({ label: sanitizeMessageLabel(resource.label), url: resource.url });
    if (rows.length >= MAX_SHARED_RESOURCE_LINKS) break;
  }
  if (rows.length === 0) return [];
  return ["Resources:", ...rows.map((row) => `- ${row.label}: ${row.url}`)];
}

// Step 10C section 16: the one pure helper for safe WhatsApp message
// composition. Deliberately lives in the client feature layer, not
// alongside the trusted session-creation service - it needs zero server
// trust (every input is already a safe field the Detail page already
// holds) and must be importable from a "use client" dialog without
// pulling in the Admin SDK. It never creates a session and never requires
// a token; `submissionUrl` is purely an optional string the caller
// supplies after a real session was created elsewhere.
//
// Finding #38: this is the ONE place the outgoing message is composed,
// including its Resources section - the dialog only ever displays this
// function's own return value, never appends/prepends a link itself.
// Same behavior for a Direct or a Vendor-routed Partner Assignment (the
// message never looks at routing at all).
export function buildWhatsAppShareMessage(params: {
  campaignName: string;
  partnerDisplayName: string | null;
  dueAt: string | null;
  platforms: string[];
  summary: string | null;
  resources?: readonly CampaignResource[];
  submissionUrl?: string;
}): string {
  const lines: string[] = [params.campaignName];
  if (params.partnerDisplayName) lines.push(`Assignment for ${params.partnerDisplayName}`);
  if (params.dueAt) lines.push(`Due: ${params.dueAt.slice(0, 10)}`);
  if (params.platforms.length > 0) lines.push(`Platforms: ${params.platforms.map(platformLabel).join(", ")}`);

  if (params.summary) {
    lines.push("");
    lines.push(params.summary);
  }

  const resourceLines = buildResourceLines(params.resources ?? []);
  if (resourceLines.length > 0) {
    lines.push("");
    lines.push(...resourceLines);
  }

  if (params.submissionUrl) {
    lines.push("");
    lines.push(`Submit published links: ${params.submissionUrl}`);
  }

  return lines.join("\n");
}

export function buildWhatsAppDeepLink(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
