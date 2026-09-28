import { z } from "zod";

// Recipient-Scoped Notifications Completion (see docs/CREATOROPS_CONTINUITY.md for the full stage
// writeup). A Notification is recipient ATTENTION STATE, derived from an authoritative source-domain
// event - never the source of truth for that event (spec section 5). Shapes follow the same
// "strict zod schema, parse-on-read/parse-on-write, fail closed on malformed data" discipline every
// other domain in this codebase uses (see src/server/operations/types.ts's own header comment).

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Event catalog (spec section 4/28's "explicit, bounded event catalog") ------------------------
// Every notification's `type` is one of exactly these. Adding a new event type is a deliberate,
// reviewed addition here - never an ad hoc string minted at a call site. See
// src/server/notifications/projection.ts for the one function per type and
// docs/CREATOROPS_CONTINUITY.md for the intentionally-unsupported event classes and why.
export const NOTIFICATION_TYPES = [
  "TASK_ASSIGNED",
  "TASK_REASSIGNED",
  "MEETING_CREATED",
  "MEETING_REVISED",
  "ACTION_ITEM_ASSIGNED",
  "ACTION_ITEM_PROMOTED",
  "CONTENT_REVIEW_DECISION",
  "REPORT_FINALIZED",
  "REPORT_SUPERSEDED",
  "ASSIGNMENT_CREATED",
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const NOTIFICATION_SOURCE_DOMAINS = ["OPERATIONS", "NOTES_MEETINGS", "REPORTS", "CONTENT", "ASSIGNMENTS"] as const;
export const notificationSourceDomainSchema = z.enum(NOTIFICATION_SOURCE_DOMAINS);
export type NotificationSourceDomain = z.infer<typeof notificationSourceDomainSchema>;

export const NOTIFICATION_SEVERITIES = ["NORMAL", "ACTION_NEEDED"] as const;
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

// A deep link is ALWAYS an app-relative path into this same product, never an absolute URL/other
// origin (section 10: "the notification itself grants no source access" - re-navigating client-side
// re-runs the destination's own authorization; an absolute/external link would be a different trust
// boundary entirely). Section 26 accessibility note: also used verbatim as the href.
const deepLinkPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^\/[A-Za-z0-9_\-/]*$/, "Deep link must be an app-relative path.");

// --- Canonical Notification record (spec section 2) -------------------------------------------------
// One doc per (recipient, event) - see ids.ts for how notificationRef/dedupeKey are derived
// deterministically so retries/concurrent emission/replay all converge on the SAME doc (spec section
// 7). `unread`/`dismissed` are denormalized booleans, server-derived and NEVER independently settable
// - they exist purely so the recipient-scoped list/count queries (spec section 9/13) stay cheap
// equality-filter queries instead of needing a range/inequality scan over readAt/dismissedAt.
export const notificationDocSchema = z
  .object({
    notificationRef: nonEmpty,
    recipientUserRef: nonEmpty,

    type: notificationTypeSchema,
    sourceDomain: notificationSourceDomainSchema,
    sourceRef: refString,
    // A short, human-inspectable event identity (e.g. "TASK_ASSIGNED" or "REPORT_FINALIZED:v3") -
    // never a raw Firestore doc id or Firebase uid; safe to show to an operator reading Firestore
    // directly, but never itself rendered as notification copy (see client-dto.ts).
    sourceEventKey: nonEmpty.max(200),

    // Safe, minimal human copy only (spec section 11) - built exclusively by copy.ts's templates,
    // never free text or interpolated raw source content.
    title: shortText(120),
    bodyPreview: shortText(240),
    deepLink: deepLinkPath,
    severity: notificationSeveritySchema.default("NORMAL"),

    dedupeKey: nonEmpty.max(300),

    createdAt: isoTimestamp,
    // The actor whose action produced this notification - null is reserved for a future purely
        // system-generated event with no human actor; every event type implemented this stage has one.
    createdByUserRef: nonEmpty.nullable().default(null),

    readAt: isoTimestamp.nullable().default(null),
    dismissedAt: isoTimestamp.nullable().default(null),
    // Section 19: a notification whose source is no longer actionable is marked stale/resolved
    // in place rather than deleted or left deep-linking to a misleading action.
    staleAt: isoTimestamp.nullable().default(null),
    expiresAt: isoTimestamp.nullable().default(null),

    // Denormalized query helpers - always `readAt === null && dismissedAt === null` and
    // `dismissedAt !== null`, respectively. Recomputed by the server on every write, never trusted
    // from a caller.
    unread: z.boolean(),
    dismissed: z.boolean(),
  })
  .strict();
export type NotificationDoc = z.infer<typeof notificationDocSchema>;

// --- Append-only per-notification event log (spec section 24) --------------------------------------
export const NOTIFICATION_EVENT_KINDS = ["NOTIFICATION_CREATED", "NOTIFICATION_READ", "NOTIFICATION_DISMISSED", "NOTIFICATION_MARK_ALL_READ"] as const;
export const notificationEventKindSchema = z.enum(NOTIFICATION_EVENT_KINDS);
export type NotificationEventKind = z.infer<typeof notificationEventKindSchema>;

export const notificationEventSchema = z
  .object({
    kind: notificationEventKindSchema,
    actorUserRef: nonEmpty,
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

// --- Service result family (mirrors src/server/operations/types.ts's own shape) --------------------
export type NotificationsDenialReason = "not_authenticated" | "not_owner";
export type NotificationsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "conflict" | "internal";

export type NotificationsServiceResult<T> = { ok: true; data: T } | { ok: false; code: NotificationsServiceErrorCode; message: string; reason?: NotificationsDenialReason };
export type NotificationsErrorResult = Extract<NotificationsServiceResult<unknown>, { ok: false }>;

const NEUTRAL_NOT_FOUND_MESSAGE = "Notification not found.";

export function notificationsUnauthorizedResult(reason: NotificationsDenialReason): NotificationsErrorResult {
  return { ok: false, code: "unauthorized", message: "Notifications access denied.", reason };
}
export function notificationsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): NotificationsErrorResult {
  return { ok: false, code: "not_found", message };
}
export function notificationsInvalidInputResult(message: string): NotificationsErrorResult {
  return { ok: false, code: "invalid_input", message };
}
export function notificationsInternalResult(message = "Something went wrong."): NotificationsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- List/query input --------------------------------------------------------------------------
export const NOTIFICATION_LIST_STATUSES = ["unread", "all", "dismissed"] as const;
export const notificationListStatusSchema = z.enum(NOTIFICATION_LIST_STATUSES);
export type NotificationListStatus = z.infer<typeof notificationListStatusSchema>;

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const MAX_NOTIFICATION_PAGE_SIZE = 50;

export const listNotificationsQuerySchema = z
  .object({
    status: notificationListStatusSchema.default("all"),
    limit: z.number().int().min(1).max(MAX_NOTIFICATION_PAGE_SIZE).optional(),
    cursor: z.string().min(1).max(500).nullable().optional(),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationRefSchema = z.string().min(1).max(80);

export const markReadInputSchema = z.object({ notificationRef: notificationRefSchema }).strict();
export const dismissInputSchema = z.object({ notificationRef: notificationRefSchema }).strict();
