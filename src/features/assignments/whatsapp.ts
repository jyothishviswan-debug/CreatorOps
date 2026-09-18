import { platformLabel } from "./format";

// Step 10C section 16: the one pure helper for safe WhatsApp message
// composition. Deliberately lives in the client feature layer, not
// alongside the trusted session-creation service - it needs zero server
// trust (every input is already a safe field the Detail page already
// holds) and must be importable from a "use client" dialog without
// pulling in the Admin SDK. It never creates a session and never requires
// a token; `submissionUrl` is purely an optional string the caller
// supplies after a real session was created elsewhere.
export function buildWhatsAppShareMessage(params: {
  campaignName: string;
  partnerDisplayName: string | null;
  dueAt: string | null;
  platforms: string[];
  summary: string | null;
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

  if (params.submissionUrl) {
    lines.push("");
    lines.push(`Submit published links: ${params.submissionUrl}`);
  }

  return lines.join("\n");
}

export function buildWhatsAppDeepLink(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
