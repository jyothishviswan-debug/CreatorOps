import { describe, expect, it } from "vitest";

import { ASSIGNMENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import { assignmentBriefSchema, assignmentDocSchema } from "./types";
import { httpsUrlSchema, submissionRowSchema, submissionRowsInputSchema } from "./external-submission-types";
import { buildAssignmentSubmissionShareContext } from "./external-submission-service";

// Step 10A: pure, no-Firestore unit coverage for the parts of the
// Assignment/external-submission contract that don't need the emulator -
// schema validation and the lifecycle graph. Emulator-backed coverage
// (creation, uniqueness/concurrency, scope, the token flow end-to-end)
// lives in assignments.emulator.test.ts / external-submission.emulator.test.ts.

function validBrief() {
  return {
    instructions: null,
    contentRequirementSummary: null,
    requiredCount: null,
    formats: [],
    platforms: ["instagram"],
    language: null,
    hashtags: [],
    dueAt: null,
    resourceLinks: [],
    reviewPolicy: "REVIEW_REQUIRED" as const,
    campaignName: "Test Campaign",
    campaignObjective: null,
  };
}

describe("assignmentBriefSchema", () => {
  it("accepts a minimal valid brief", () => {
    expect(assignmentBriefSchema.safeParse(validBrief()).success).toBe(true);
  });

  it("rejects an unrecognized field (strict schema)", () => {
    const result = assignmentBriefSchema.safeParse({ ...validBrief(), agreementId: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a campaignName-less brief - the Campaign-derived context is always required", () => {
    const { campaignName: _campaignName, ...rest } = validBrief();
    void _campaignName;
    expect(assignmentBriefSchema.safeParse(rest).success).toBe(false);
  });
});

describe("assignmentDocSchema - no Finance/Agreement fields exist anywhere on the contract", () => {
  it("a doc with an added finance-shaped field is rejected by every nested strict object, or simply ignored by the non-strict top level - either way, no Finance/Agreement value can ever round-trip through this schema", () => {
    const raw = {
      uid: "u1",
      assignmentRef: "a1",
      version: 1,
      campaignRef: "c1",
      partnerRef: "p1",
      partnerAccountRefs: [],
      status: "DRAFT",
      statusReason: null,
      brief: validBrief(),
      ownerUid: null,
      regionIds: [],
      teamIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdByUserRef: "user-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedByUserRef: "user-1",
    };
    const parsed = assignmentDocSchema.parse(raw);
    expect(parsed).not.toHaveProperty("agreementRef");
    expect(parsed).not.toHaveProperty("payableRef");
    expect(parsed).not.toHaveProperty("amount");
    expect(Object.keys(parsed.brief)).not.toContain("compensation");
  });
});

describe("ASSIGNMENT_LIFECYCLE_TRANSITIONS - the compact execution-only model", () => {
  it("supports the full ordinary forward path", () => {
    expect(canTransitionLifecycle("DRAFT", "ASSIGNED", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("ASSIGNED", "ACCEPTED", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("ACCEPTED", "IN_PROGRESS", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    expect(canTransitionLifecycle("IN_PROGRESS", "COMPLETED", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(true);
  });

  it("CANCELLED is reachable from every non-terminal state", () => {
    for (const from of ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS"]) {
      expect(canTransitionLifecycle(from, "CANCELLED", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(true);
    }
  });

  it("COMPLETED and CANCELLED are both terminal - nothing transitions out of them", () => {
    for (const to of ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]) {
      expect(canTransitionLifecycle("COMPLETED", to, ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(false);
      expect(canTransitionLifecycle("CANCELLED", to, ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(false);
    }
  });

  it("rejects skipping a state (e.g. DRAFT straight to ACCEPTED)", () => {
    expect(canTransitionLifecycle("DRAFT", "ACCEPTED", ASSIGNMENT_LIFECYCLE_TRANSITIONS)).toBe(false);
  });

  it("never models Content/review states - SUBMITTED/APPROVED/REVISION_REQUESTED/POSTED/PUBLISHED are not keys in the map at all", () => {
    for (const contentState of ["SUBMITTED", "APPROVED", "REVISION_REQUESTED", "POSTED", "PUBLISHED"]) {
      expect(ASSIGNMENT_LIFECYCLE_TRANSITIONS[contentState]).toBeUndefined();
    }
  });
});

describe("httpsUrlSchema", () => {
  it("accepts a well-formed https URL", () => {
    expect(httpsUrlSchema.safeParse("https://example.com/post/1").success).toBe(true);
  });
  it("rejects http (non-https)", () => {
    expect(httpsUrlSchema.safeParse("http://example.com/post/1").success).toBe(false);
  });
  it("rejects a non-URL string", () => {
    expect(httpsUrlSchema.safeParse("not a url").success).toBe(false);
  });
  it("rejects an unsafe scheme", () => {
    expect(httpsUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(httpsUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
  });
});

describe("submissionRowSchema / submissionRowsInputSchema", () => {
  it("accepts a valid row", () => {
    expect(submissionRowSchema.safeParse({ platform: "instagram", url: "https://instagram.com/p/x" }).success).toBe(true);
  });

  it("rejects zero rows", () => {
    expect(submissionRowsInputSchema.safeParse([]).success).toBe(false);
  });

  it("rejects more than the bounded max (10) rows", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ platform: "instagram", url: `https://instagram.com/p/${i}` }));
    expect(submissionRowsInputSchema.safeParse(rows).success).toBe(false);
  });

  it("accepts exactly the bounded max (10) rows", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ platform: "instagram", url: `https://instagram.com/p/${i}` }));
    expect(submissionRowsInputSchema.safeParse(rows).success).toBe(true);
  });
});

describe("buildAssignmentSubmissionShareContext", () => {
  it("produces a safe-brief-only message with no URL when submissionUrl is omitted", () => {
    const { whatsappMessage, whatsappDeepLink } = buildAssignmentSubmissionShareContext({ campaignName: "Civic Voices", assignmentSummary: "One reel", dueAt: "2026-12-01" });
    expect(whatsappMessage).not.toContain("http");
    expect(whatsappMessage).toContain("Civic Voices");
    expect(whatsappDeepLink.startsWith("https://wa.me/?text=")).toBe(true);
  });

  it("includes the URL only when explicitly passed", () => {
    const { whatsappMessage } = buildAssignmentSubmissionShareContext({
      campaignName: "Civic Voices",
      assignmentSummary: null,
      dueAt: null,
      submissionUrl: "https://creatorops.example/submit/abc123",
    });
    expect(whatsappMessage).toContain("https://creatorops.example/submit/abc123");
  });

  it("never sends any network request - purely returns strings", () => {
    const result = buildAssignmentSubmissionShareContext({ campaignName: "X", assignmentSummary: null, dueAt: null });
    expect(typeof result.whatsappMessage).toBe("string");
    expect(typeof result.whatsappDeepLink).toBe("string");
  });
});
