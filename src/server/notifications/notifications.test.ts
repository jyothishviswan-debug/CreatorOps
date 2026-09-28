import { describe, expect, it } from "vitest";

import { toNotificationDto } from "./client-dto";
import {
  buildActionItemAssignedCopy,
  buildActionItemPromotedCopy,
  buildAssignmentCreatedCopy,
  buildContentReviewDecisionCopy,
  buildMeetingCreatedCopy,
  buildMeetingRevisedCopy,
  buildReportFinalizedCopy,
  buildReportSupersededCopy,
  buildTaskAssignedCopy,
  buildTaskReassignedCopy,
} from "./copy";
import { assignmentDeepLink, contentDeepLink, meetingOwnerDeepLink, reportDeepLink, taskDeepLink } from "./deep-links";
import { buildDedupeKey, generateNotificationRef } from "./ids";
import { NOTIFICATION_TYPES, notificationDocSchema, type NotificationDoc } from "./types";

// Notifications Completion - required unit tests (spec section 27): schema; safe-copy builder;
// dedupe key; safe DTO; raw-ref suppression; deep-link builder; event catalog. Firestore-backed
// behavior (idempotent/concurrent create, recipient isolation, read/dismiss lifecycle, unread count,
// event->recipient mapping through the real hooks) lives in notifications.emulator.test.ts.

function baseDoc(overrides: Partial<NotificationDoc> = {}): NotificationDoc {
  return {
    notificationRef: "ntf_abc123",
    recipientUserRef: "user_recipient",
    type: "TASK_ASSIGNED",
    sourceDomain: "OPERATIONS",
    sourceRef: "task_123",
    sourceEventKey: "TASK_ASSIGNED",
    title: "Task assigned",
    bodyPreview: 'You were assigned "Prepare campaign brief".',
    deepLink: "/operations/tasks/task_123",
    severity: "NORMAL",
    dedupeKey: "OPERATIONS|task_123|TASK_ASSIGNED|user_recipient|1",
    createdAt: "2025-01-01T00:00:00.000Z",
    createdByUserRef: "user_actor",
    readAt: null,
    dismissedAt: null,
    staleAt: null,
    expiresAt: null,
    unread: true,
    dismissed: false,
    ...overrides,
  };
}

describe("event catalog (spec section 4/28)", () => {
  it("is exactly the 10 supported types - a deliberate, reviewed catalog, never an ad hoc string", () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe("schema (spec section 2)", () => {
  it("accepts a well-formed doc", () => {
    expect(notificationDocSchema.safeParse(baseDoc()).success).toBe(true);
  });

  it("rejects an absolute-URL deep link - a deep link must always be an app-relative path", () => {
    expect(notificationDocSchema.safeParse(baseDoc({ deepLink: "https://evil.example.com/steal" })).success).toBe(false);
    expect(notificationDocSchema.safeParse(baseDoc({ deepLink: "javascript:alert(1)" })).success).toBe(false);
    expect(notificationDocSchema.safeParse(baseDoc({ deepLink: "operations/tasks/x" })).success).toBe(false); // missing leading slash
  });

  it("rejects an unknown type/sourceDomain - the catalog is closed", () => {
    expect(notificationDocSchema.safeParse(baseDoc({ type: "SOMETHING_ELSE" as never })).success).toBe(false);
    expect(notificationDocSchema.safeParse(baseDoc({ sourceDomain: "FINANCE" as never })).success).toBe(false);
  });

  it("rejects extra/unknown fields (.strict()) - no silent schema drift", () => {
    expect(notificationDocSchema.safeParse({ ...baseDoc(), extraField: "nope" }).success).toBe(false);
  });

  it("requires a non-empty recipientUserRef - never an unscoped/global notification", () => {
    expect(notificationDocSchema.safeParse(baseDoc({ recipientUserRef: "" })).success).toBe(false);
  });
});

describe("dedupe key + notificationRef (spec section 7)", () => {
  it("is deterministic - identical inputs always produce the identical key and ref", () => {
    const a = buildDedupeKey({ sourceDomain: "OPERATIONS", type: "TASK_ASSIGNED", sourceRef: "task_1", recipientUserRef: "user_1" });
    const b = buildDedupeKey({ sourceDomain: "OPERATIONS", type: "TASK_ASSIGNED", sourceRef: "task_1", recipientUserRef: "user_1" });
    expect(a).toBe(b);
    expect(generateNotificationRef(a)).toBe(generateNotificationRef(b));
    expect(generateNotificationRef(a)).toMatch(/^ntf_[0-9a-f]{32}$/);
  });

  it("differs by recipient - the same source event never collides across two different recipients", () => {
    const a = buildDedupeKey({ sourceDomain: "OPERATIONS", type: "TASK_ASSIGNED", sourceRef: "task_1", recipientUserRef: "user_1" });
    const b = buildDedupeKey({ sourceDomain: "OPERATIONS", type: "TASK_ASSIGNED", sourceRef: "task_1", recipientUserRef: "user_2" });
    expect(generateNotificationRef(a)).not.toBe(generateNotificationRef(b));
  });

  it("differs by sourceRef and by type - different sources/events never collide", () => {
    const base = { sourceDomain: "OPERATIONS" as const, type: "TASK_ASSIGNED" as const, sourceRef: "task_1", recipientUserRef: "user_1" };
    const diffSource = buildDedupeKey({ ...base, sourceRef: "task_2" });
    const diffType = buildDedupeKey({ ...base, type: "TASK_REASSIGNED" });
    const original = buildDedupeKey(base);
    expect(diffSource).not.toBe(original);
    expect(diffType).not.toBe(original);
  });

  it("a one-shot event (no distinguisher) is stable across repeated calls - retries converge", () => {
    const first = buildDedupeKey({ sourceDomain: "NOTES_MEETINGS", type: "MEETING_CREATED", sourceRef: "meeting_1", recipientUserRef: "user_1" });
    const second = buildDedupeKey({ sourceDomain: "NOTES_MEETINGS", type: "MEETING_CREATED", sourceRef: "meeting_1", recipientUserRef: "user_1" });
    expect(first).toBe(second);
  });

  it("a recurring event's distinguisher makes a genuinely new occurrence a NEW dedupe key/ref", () => {
    const rev1 = buildDedupeKey({ sourceDomain: "NOTES_MEETINGS", type: "MEETING_REVISED", sourceRef: "meeting_1", recipientUserRef: "user_1", distinguisher: "2" });
    const rev2 = buildDedupeKey({ sourceDomain: "NOTES_MEETINGS", type: "MEETING_REVISED", sourceRef: "meeting_1", recipientUserRef: "user_1", distinguisher: "3" });
    expect(rev1).not.toBe(rev2);
    expect(generateNotificationRef(rev1)).not.toBe(generateNotificationRef(rev2));
  });
});

describe("safe-copy builder (spec section 11) - never raw refs/uids/errors, always short and human", () => {
  const REF_LIKE = /\b(ntf|task|meeting|ai|rrun|rpt|asg|cnt)_[a-z0-9]{6,}\b/i;

  const samples = [
    buildTaskAssignedCopy('Prepare campaign brief for "Nike Q3"'),
    buildTaskReassignedCopy("Draft outreach email"),
    buildMeetingCreatedCopy("Weekly sync"),
    buildMeetingRevisedCopy("Weekly sync"),
    buildActionItemAssignedCopy("Send the revised brief to legal"),
    buildActionItemPromotedCopy("Send the revised brief to legal"),
    buildContentReviewDecisionCopy("approved"),
    buildContentReviewDecisionCopy("revision_requested"),
    buildReportFinalizedCopy(),
    buildReportSupersededCopy(),
    buildAssignmentCreatedCopy(),
  ];

  it("every copy is non-empty, within length limits, and contains no ref-shaped id", () => {
    for (const copy of samples) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.title.length).toBeLessThanOrEqual(120);
      expect(copy.bodyPreview.length).toBeGreaterThan(0);
      expect(copy.bodyPreview.length).toBeLessThanOrEqual(240);
      expect(copy.title).not.toMatch(REF_LIKE);
      expect(copy.bodyPreview).not.toMatch(REF_LIKE);
    }
  });

  it("truncates an overlong title safely rather than exceeding the limit", () => {
    const longTitle = "x".repeat(500);
    const copy = buildTaskAssignedCopy(longTitle);
    expect(copy.bodyPreview.length).toBeLessThanOrEqual(240);
    expect(copy.bodyPreview.endsWith("…")).toBe(true);
  });
});

describe("deep-link builder (spec section 10)", () => {
  it("builds real, app-relative single-item routes", () => {
    expect(taskDeepLink("task_abc")).toBe("/operations/tasks/task_abc");
    expect(contentDeepLink("cnt_abc")).toBe("/content/cnt_abc");
    expect(assignmentDeepLink("asg_abc")).toBe("/assignments/asg_abc");
    expect(reportDeepLink("report-1")).toBe("/reports/report-1");
  });

  it("URL-encodes the ref segment - never lets a ref value break out of the path", () => {
    expect(taskDeepLink("weird/../ref")).toBe(`/operations/tasks/${encodeURIComponent("weird/../ref")}`);
  });

  it("resolves a Meeting/ActionItem's owner-record deep link for every SUPPORTED owner type", () => {
    expect(meetingOwnerDeepLink("ASSIGNMENT", "asg_1")).toBe("/assignments/asg_1");
    expect(meetingOwnerDeepLink("CONTENT", "cnt_1")).toBe("/content/cnt_1");
    expect(meetingOwnerDeepLink("CAMPAIGN", "cmp_1")).toBe("/campaigns/cmp_1");
    expect(meetingOwnerDeepLink("PARTNER", "prt_1")).toBe("/partners/prt_1");
    expect(meetingOwnerDeepLink("VENDOR", "vnd_1")).toBe("/vendors/vnd_1");
    expect(meetingOwnerDeepLink("DISCOVERY_LEAD", "lead_1")).toBe("/discovery/lead_1");
  });

  it("fails closed (returns null) for an unrecognized/FUTURE owner type - never guesses a route", () => {
    expect(meetingOwnerDeepLink("PARTNER_REVIEW", "pr_1")).toBeNull();
    expect(meetingOwnerDeepLink("SOMETHING_UNKNOWN", "x")).toBeNull();
  });
});

describe("safe DTO / raw-ref suppression (spec section 12/31)", () => {
  it("never exposes dedupeKey, sourceEventKey, sourceRef, or createdByUserRef to the client", () => {
    const dto = toNotificationDto(baseDoc()) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("dedupeKey");
    expect(dto).not.toHaveProperty("sourceEventKey");
    expect(dto).not.toHaveProperty("sourceRef");
    expect(dto).not.toHaveProperty("createdByUserRef");
  });

  it("re-derives `unread` from readAt/dismissedAt rather than blindly trusting the stored flag", () => {
    const readDoc = baseDoc({ readAt: "2025-01-02T00:00:00.000Z", unread: true }); // deliberately inconsistent stored flag
    expect(toNotificationDto(readDoc).unread).toBe(false);
    const dismissedDoc = baseDoc({ dismissedAt: "2025-01-02T00:00:00.000Z", unread: true });
    expect(toNotificationDto(dismissedDoc).unread).toBe(false);
    expect(toNotificationDto(baseDoc()).unread).toBe(true);
  });

  it("carries the safe, minimal fields the UI actually needs", () => {
    const dto = toNotificationDto(baseDoc());
    expect(dto).toEqual({
      notificationRef: "ntf_abc123",
      type: "TASK_ASSIGNED",
      sourceDomain: "OPERATIONS",
      title: "Task assigned",
      bodyPreview: 'You were assigned "Prepare campaign brief".',
      deepLink: "/operations/tasks/task_123",
      severity: "NORMAL",
      createdAt: "2025-01-01T00:00:00.000Z",
      readAt: null,
      dismissedAt: null,
      staleAt: null,
      unread: true,
    });
  });
});

describe("stale/resolved state (spec section 19)", () => {
  it("a staleAt-marked notification still parses and is preserved historically, not deleted", () => {
    const stale = baseDoc({ staleAt: "2025-01-03T00:00:00.000Z" });
    expect(notificationDocSchema.safeParse(stale).success).toBe(true);
    expect(toNotificationDto(stale).staleAt).toBe("2025-01-03T00:00:00.000Z");
  });
});
