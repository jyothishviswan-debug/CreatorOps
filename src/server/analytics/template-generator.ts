import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getPartner, listPartners } from "@/server/partners/partner-service";
import { listPartnerAccounts } from "@/server/partners/partner-account-service";
import { generateXlsx } from "@/server/exports/xlsx";
import type { ExportColumnDef, ExportRow } from "@/server/exports/types";

import { requireAnalyticsManageAccess, requireImportsModuleAccess } from "./analytics-gate";
import { analyticsInvalidInputResult, analyticsUnauthorizedResult, type AnalyticsServiceResult } from "./types";

// Finding #56: "Download Template" for the Import Center's Analytics "Choose data" step. Generates a
// REAL .xlsx derived from the current import context (target kind / platform / Partner selection),
// built against the same `xlsx` dependency and the same explicit-cell-typed/formula-injection-
// neutralized discipline as the Export Center's own generateXlsx (src/server/exports/xlsx.ts) -
// reused directly rather than reinvented.
//
// Column choice: exactly the finding's own approved shape, with two deliberate, disclosed
// corrections against the literal column names - "Current Followers"/"Current Subscribers" are
// replaced with the ACTUALLY-recognized alias headers ("Followers"/"Subscribers", per
// instagram-content-adapter.ts / youtube-content-adapter.ts's own INSTAGRAM_CONTENT_HEADER_ALIASES /
// YOUTUBE_CONTENT_HEADER_ALIASES) so the generated file genuinely round-trips through the real parser
// without manual remapping, per the finding's own explicit requirement. "Platform" and "Reporting
// Period" are included exactly as the approved shape lists them, but are NOT read by the content-row
// parser today (Platform is inferred by which adapter recognizes the sheet; Reporting Period is
// derived per-row from Post Date, finding #66) - they are informational/contextual columns only,
// disclosed here rather than silently included as if load-bearing.
const contentPlatformSchema = z.enum(["instagram", "youtube"]);
export type TemplateContentPlatform = z.infer<typeof contentPlatformSchema>;

// Never a literal fetch-all: "All" is bounded to this many rows, same discipline as
// assignment-options-service.ts's own MAX_ASSIGNMENT_PARTNER_SEARCH_RESULTS-style caps elsewhere in
// this codebase - just a larger bound, since a template is a one-shot download, not a live picker.
export const TEMPLATE_MAX_PARTNER_ROWS = 100;

const partnerSelectionInputSchema = z.union([
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("selected"), partnerRefs: z.array(z.string().min(1)).min(1).max(TEMPLATE_MAX_PARTNER_ROWS) }).strict(),
]);

const generateTemplateInputSchema = z
  .object({
    targetKind: z.enum(["campaign_content", "channel_account"]),
    contentPlatform: contentPlatformSchema.optional(),
    channelPlatform: z.string().min(1).max(60).optional(),
    partnerSelection: partnerSelectionInputSchema,
  })
  .strict()
  .refine((v) => v.targetKind !== "campaign_content" || v.contentPlatform !== undefined, { message: "contentPlatform is required for campaign_content." });

export type GenerateAnalyticsTemplateInput = z.input<typeof generateTemplateInputSchema>;

type TemplateRowContext = { displayName: string; handle: string | null };

// One canonical header string per recognized field - see the header comment above for the two
// disclosed deviations from the finding's own literal column names.
export function instagramColumns(): ExportColumnDef[] {
  return [
    { id: "partner", label: "Partner" },
    { id: "handle", label: "Username" },
    { id: "platform", label: "Platform" },
    { id: "reportingPeriod", label: "Reporting Period" },
    { id: "postId", label: "Platform Content ID" },
    { id: "postUrl", label: "Post URL" },
    { id: "postType", label: "Post Type" },
    { id: "postDate", label: "Post Date" },
    { id: "views", label: "Views" },
    { id: "likes", label: "Likes" },
    { id: "comments", label: "Comments" },
    { id: "followers", label: "Followers" },
    { id: "notes", label: "Notes" },
  ];
}

export function youtubeColumns(): ExportColumnDef[] {
  return [
    { id: "partner", label: "Partner" },
    { id: "handle", label: "Channel Handle" },
    { id: "platform", label: "Platform" },
    { id: "reportingPeriod", label: "Reporting Period" },
    { id: "postId", label: "Platform Content ID" },
    { id: "postUrl", label: "Video URL" },
    { id: "postDate", label: "Publish Date" },
    { id: "views", label: "Views" },
    { id: "likes", label: "Likes" },
    { id: "comments", label: "Comments" },
    { id: "followers", label: "Subscribers" },
    { id: "notes", label: "Notes" },
  ];
}

// The channel/account snapshot target has no Instagram/YouTube split (one shared adapter, one shared
// header set - channel-snapshot-adapter.ts's own CHANNEL_SNAPSHOT_HEADER_ALIASES) - "the equivalent
// current canonical columns" for this target, per the finding's own instruction.
export function channelAccountColumns(): ExportColumnDef[] {
  return [
    { id: "partner", label: "Partner" },
    { id: "handle", label: "Handle" },
    { id: "platform", label: "Platform" },
    { id: "platformAccountId", label: "Platform Account ID" },
    { id: "profileUrl", label: "Profile URL" },
    { id: "followers", label: "Followers" },
    { id: "notes", label: "Notes" },
  ];
}

function contentRow(columns: ExportColumnDef[], ctx: TemplateRowContext | null): ExportRow {
  const row: ExportRow = {};
  for (const col of columns) row[col.id] = null;
  if (ctx) {
    row.partner = ctx.displayName;
    row.handle = ctx.handle;
  }
  return row;
}

// Finding #56: prefill ONLY trusted context (Partner display name, canonical account handle/channel,
// Platform) - every performance/content value stays blank, never fabricated. Resolves "selected"
// Partners individually (each independently Record-Scope-gated by getPartner - a forged/out-of-scope
// ref is silently dropped, never rejecting the whole request and never leaking which ones failed) and
// "all" via the same bounded, scoped listPartners search every other picker in this codebase already
// uses (never a client-side fetch-all-then-hide).
export async function generateAnalyticsImportTemplate(actor: ActorContext | null, rawInput: unknown): Promise<AnalyticsServiceResult<{ filename: string; bytes: Uint8Array }>> {
  const moduleGate = await requireImportsModuleAccess(actor);
  if (!moduleGate.ok) return analyticsUnauthorizedResult(moduleGate.reason);
  const manageGate = await requireAnalyticsManageAccess(actor);
  if (!manageGate.ok) return analyticsUnauthorizedResult(manageGate.reason);

  const parsed = generateTemplateInputSchema.safeParse(rawInput);
  if (!parsed.success) return analyticsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const columns = input.targetKind === "channel_account" ? channelAccountColumns() : input.contentPlatform === "youtube" ? youtubeColumns() : instagramColumns();
  const platformLabel = input.targetKind === "channel_account" ? (input.channelPlatform ?? "") : input.contentPlatform === "youtube" ? "YouTube" : "Instagram";

  // Resolve Partner rows - bounded and scope-checked either way; a forged/unauthorized ref in
  // "selected" is silently dropped (never widens access, never leaks existence), and "all" never
  // fetches more than TEMPLATE_MAX_PARTNER_ROWS.
  const partnerContexts: TemplateRowContext[] = [];
  if (input.partnerSelection.mode === "selected") {
    for (const ref of input.partnerSelection.partnerRefs) {
      const result = await getPartner(actor, ref);
      if (!result.ok) continue;
      partnerContexts.push({ displayName: result.data.displayName, handle: await primaryHandleFor(actor, result.data.partnerRef, input) });
    }
  } else {
    const result = await listPartners(actor, { status: "ACTIVE", limit: TEMPLATE_MAX_PARTNER_ROWS });
    if (result.ok) {
      for (const partner of result.data.partners) {
        partnerContexts.push({ displayName: partner.displayName, handle: await primaryHandleFor(actor, partner.partnerRef, input) });
      }
    }
  }

  const rowContexts = partnerContexts.length > 0 ? partnerContexts : [null];
  const rows: ExportRow[] = rowContexts.map((ctx) => {
    const row = contentRow(columns, ctx);
    row.platform = platformLabel || null;
    return row;
  });

  const bytes = generateXlsx(columns, rows);
  const suffix = input.targetKind === "channel_account" ? "channel-account" : input.contentPlatform;
  return { ok: true, data: { filename: `analytics-import-template-${suffix}.xlsx`, bytes } };
}

// Best-effort: the Partner's own PRIMARY account on the relevant platform (falling back to the first
// match) - never fabricated, left blank if the Partner has no matching account yet.
async function primaryHandleFor(actor: ActorContext | null, partnerRef: string, input: { targetKind: "campaign_content" | "channel_account"; contentPlatform?: TemplateContentPlatform; channelPlatform?: string }): Promise<string | null> {
  const accountsResult = await listPartnerAccounts(actor, partnerRef);
  if (!accountsResult.ok) return null;
  const targetPlatform = input.targetKind === "channel_account" ? (input.channelPlatform ?? "").toLowerCase() : input.contentPlatform;
  const candidates = targetPlatform ? accountsResult.data.filter((a) => a.platform.toLowerCase() === targetPlatform) : accountsResult.data;
  const chosen = candidates.find((a) => a.primary) ?? candidates[0];
  return chosen?.handle ?? null;
}
