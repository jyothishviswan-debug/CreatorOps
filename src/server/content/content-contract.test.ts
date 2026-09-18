import { describe, expect, it } from "vitest";

import { contentPublicationClaimId } from "./firestore";
import { normalizeContentUrl, publicationUrlIdentityKey } from "./publication-identity";
import { contentDocSchema, contentPublicationClaimDocSchema, contentAssignmentThreadClaimDocSchema, contentRevisionDocSchema, qualifyingFulfillmentSchema } from "./types";

// Step 11A.1: pure schema/logic unit coverage - no emulator, no
// Firestore. Mirrors the repo's other *-contract.test.ts idiom
// (round-trip every schema through .parse(), assert the pure
// identity-key/hash helpers' own composition and determinism).

function baseContentDoc() {
  return {
    uid: "content-uid-1",
    contentRef: "content-ref-1",
    version: 1,
    assignmentRef: "assignment-ref-1",
    campaignRef: "campaign-ref-1",
    partnerRef: "partner-ref-1",
    status: "OPEN" as const,
    statusReason: null,
    currentRevisionNumber: 0,
    reviewedRevisionNumber: null,
    currentLinks: [],
    qualifyingFulfillment: null,
    dueAt: null,
    openedAt: "2026-01-01T00:00:00.000Z",
    firstSubmittedAt: null,
    lastSubmittedAt: null,
    approvedAt: null,
    cancelledAt: null,
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdByUserRef: "user-ref-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedByUserRef: "user-ref-1",
  };
}

describe("contentDocSchema", () => {
  it("round-trips a minimal valid Content doc", () => {
    const parsed = contentDocSchema.parse(baseContentDoc());
    expect(parsed.status).toBe("OPEN");
    expect(parsed.currentRevisionNumber).toBe(0);
    expect(parsed.qualifyingFulfillment).toBeNull();
  });

  it("round-trips a fully populated Content doc, including nested currentLinks/qualifyingFulfillment", () => {
    const doc = {
      ...baseContentDoc(),
      status: "APPROVED" as const,
      currentRevisionNumber: 2,
      reviewedRevisionNumber: 2,
      currentLinks: [
        {
          platform: "instagram",
          originalUrl: "https://instagram.com/p/abc",
          normalizedUrl: "https://instagram.com/p/abc",
          recordedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED" as const, reasonCode: null, determinedAt: "2026-01-03T00:00:00.000Z" },
    };
    const parsed = contentDocSchema.parse(doc);
    expect(parsed.currentLinks).toHaveLength(1);
    expect(parsed.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");
  });

  it("rejects a currentRevisionNumber below 0 and a reviewedRevisionNumber below 1", () => {
    expect(() => contentDocSchema.parse({ ...baseContentDoc(), currentRevisionNumber: -1 })).toThrow();
    expect(() => contentDocSchema.parse({ ...baseContentDoc(), reviewedRevisionNumber: 0 })).toThrow();
  });
});

describe("contentRevisionDocSchema", () => {
  it("round-trips a minimal revision doc", () => {
    const parsed = contentRevisionDocSchema.parse({
      uid: "r1",
      revisionNumber: 1,
      rows: [{ platform: "instagram", originalUrl: "https://instagram.com/p/abc", normalizedUrl: "https://instagram.com/p/abc" }],
      recipientType: "PARTNER",
      recipientRef: "partner-ref-1",
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.rows).toHaveLength(1);
  });

  it("requires at least one row", () => {
    expect(() =>
      contentRevisionDocSchema.parse({ uid: "r1", revisionNumber: 1, rows: [], recipientType: "PARTNER", recipientRef: "partner-ref-1", submittedAt: "2026-01-01T00:00:00.000Z" }),
    ).toThrow();
  });

  it("rejects an unrecognized field (strict schema)", () => {
    expect(() =>
      contentRevisionDocSchema.parse({
        uid: "r1",
        revisionNumber: 1,
        rows: [{ platform: "instagram", originalUrl: "https://instagram.com/p/abc", normalizedUrl: "https://instagram.com/p/abc" }],
        recipientType: "PARTNER",
        recipientRef: "partner-ref-1",
        submittedAt: "2026-01-01T00:00:00.000Z",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("qualifyingFulfillmentSchema", () => {
  it("round-trips each fulfillment kind", () => {
    for (const kind of ["QUALIFYING_REQUIRED", "QUALIFYING_EXTRA", "NON_QUALIFYING"] as const) {
      const parsed = qualifyingFulfillmentSchema.parse({ kind, reasonCode: kind === "NON_QUALIFYING" ? "OBLIGATION_MISMATCH" : null, determinedAt: "2026-01-01T00:00:00.000Z" });
      expect(parsed.kind).toBe(kind);
    }
  });
});

describe("contentAssignmentThreadClaimDocSchema", () => {
  it("round-trips the one-canonical-thread-per-Assignment claim", () => {
    const parsed = contentAssignmentThreadClaimDocSchema.parse({
      assignmentRef: "assignment-ref-1",
      contentRef: "content-ref-1",
      contentUid: "content-uid-1",
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.assignmentRef).toBe("assignment-ref-1");
  });
});

describe("contentPublicationClaimDocSchema", () => {
  it("round-trips a claim doc, now carrying a revisionNumber instead of an evidenceId", () => {
    const parsed = contentPublicationClaimDocSchema.parse({
      key: "url:instagram:https://instagram.com/p/abc",
      contentRef: "content-ref-1",
      contentUid: "content-uid-1",
      revisionNumber: 1,
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.key).toBe("url:instagram:https://instagram.com/p/abc");
    expect(parsed.revisionNumber).toBe(1);
  });
});

describe("normalizeContentUrl", () => {
  it("lowercases the host", () => {
    expect(normalizeContentUrl("https://Instagram.COM/p/abc")).toBe("https://instagram.com/p/abc");
  });

  it("strips exactly one trailing path slash", () => {
    expect(normalizeContentUrl("https://instagram.com/p/abc/")).toBe("https://instagram.com/p/abc");
    // A bare-root path ("/") is never stripped down to nothing.
    expect(normalizeContentUrl("https://instagram.com/")).toBe("https://instagram.com/");
  });

  it("drops the fragment", () => {
    expect(normalizeContentUrl("https://instagram.com/p/abc#igsh=xyz")).toBe("https://instagram.com/p/abc");
  });

  it("keeps the query string exactly as-is", () => {
    expect(normalizeContentUrl("https://youtube.com/watch?v=abc123")).toBe("https://youtube.com/watch?v=abc123");
  });

  it("falls back to a trimmed, lowercased string for an unparseable value, never throwing", () => {
    expect(() => normalizeContentUrl("not a url")).not.toThrow();
    expect(normalizeContentUrl("  Not A URL  ")).toBe("not a url");
  });

  it("combines all rules together", () => {
    expect(normalizeContentUrl("HTTPS://Instagram.COM/P/Abc/?utm_source=x#frag")).toBe("https://instagram.com/P/Abc?utm_source=x");
  });
});

describe("publicationUrlIdentityKey", () => {
  it("composes a namespaced, platform-scoped key", () => {
    expect(publicationUrlIdentityKey("instagram", "https://instagram.com/p/abc")).toBe("url:instagram:https://instagram.com/p/abc");
  });

  it("the same normalized URL under a different platform is a different identity", () => {
    const a = publicationUrlIdentityKey("instagram", "https://example.com/x");
    const b = publicationUrlIdentityKey("youtube", "https://example.com/x");
    expect(a).not.toBe(b);
  });
});

describe("contentPublicationClaimId", () => {
  it("is deterministic - the same input always hashes to the same id", () => {
    const key = "url:instagram:https://instagram.com/p/abc";
    expect(contentPublicationClaimId(key)).toBe(contentPublicationClaimId(key));
  });

  it("different inputs hash to different ids", () => {
    expect(contentPublicationClaimId("url:instagram:https://instagram.com/p/abc")).not.toBe(contentPublicationClaimId("url:instagram:https://instagram.com/p/xyz"));
  });

  it("produces a hex sha256-shaped id", () => {
    const id = contentPublicationClaimId("url:instagram:https://instagram.com/p/abc");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});
