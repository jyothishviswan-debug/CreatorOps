import { describe, expect, it } from "vitest";

import { contentPublicationClaimId, contentRequiredSlotClaimDocId } from "./firestore";
import { normalizeContentUrl, publicationContentIdIdentityKey, publicationUrlIdentityKey } from "./publication-identity";
import {
  contentDocSchema,
  contentPublicationClaimDocSchema,
  contentRequiredSlotClaimDocSchema,
  contentVersionDocSchema,
  publicationEvidenceItemSchema,
  qualifyingFulfillmentSchema,
} from "./types";

// Step 11A: pure schema/logic unit coverage - no emulator, no Firestore.
// Mirrors the repo's other *-contract.test.ts idiom (round-trip every
// schema through .parse(), assert the pure identity-key/hash helpers'
// own composition and determinism).

function baseContentDoc() {
  return {
    uid: "content-uid-1",
    contentRef: "content-ref-1",
    version: 1,
    assignmentRef: "assignment-ref-1",
    campaignRef: "campaign-ref-1",
    partnerRef: "partner-ref-1",
    partnerAccountRef: null,
    platform: "instagram",
    contentType: "reel",
    title: null,
    status: "PLANNED" as const,
    statusReason: null,
    reviewPolicy: "REVIEW_REQUIRED" as const,
    currentVersion: 0,
    lastSubmittedVersion: null,
    publicationEvidence: [],
    qualifyingFulfillment: null,
    requiredSlotIndex: null,
    supersedesContentRef: null,
    dueAt: null,
    productionStartedAt: null,
    submittedAt: null,
    approvedAt: null,
    postedAt: null,
    completedAt: null,
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
    expect(parsed.status).toBe("PLANNED");
    expect(parsed.currentVersion).toBe(0);
    expect(parsed.qualifyingFulfillment).toBeNull();
  });

  it("round-trips a fully populated Content doc, including nested publicationEvidence/qualifyingFulfillment", () => {
    const doc = {
      ...baseContentDoc(),
      status: "COMPLETED" as const,
      currentVersion: 2,
      lastSubmittedVersion: 2,
      requiredSlotIndex: 0,
      supersedesContentRef: "content-ref-old",
      publicationEvidence: [
        {
          evidenceId: "evidence-1",
          platform: "instagram",
          originalUrl: "https://instagram.com/p/abc",
          normalizedUrl: "https://instagram.com/p/abc",
          platformContentId: "pcid-1",
          partnerAccountRef: "account-ref-1",
          publishedAt: "2026-01-02T00:00:00.000Z",
          recordedAt: "2026-01-02T00:00:00.000Z",
          recordedByUserRef: "user-ref-1",
          provenance: "STAFF_RECORDED" as const,
          sourceExternalSubmissionRef: null,
        },
      ],
      qualifyingFulfillment: { kind: "QUALIFYING_REQUIRED" as const, reasonCode: null, determinedAt: "2026-01-03T00:00:00.000Z" },
    };
    const parsed = contentDocSchema.parse(doc);
    expect(parsed.publicationEvidence).toHaveLength(1);
    expect(parsed.qualifyingFulfillment?.kind).toBe("QUALIFYING_REQUIRED");
    expect(parsed.supersedesContentRef).toBe("content-ref-old");
  });

  it("rejects a currentVersion below 0 and a lastSubmittedVersion below 1", () => {
    expect(() => contentDocSchema.parse({ ...baseContentDoc(), currentVersion: -1 })).toThrow();
    expect(() => contentDocSchema.parse({ ...baseContentDoc(), lastSubmittedVersion: 0 })).toThrow();
  });
});

describe("contentVersionDocSchema", () => {
  it("round-trips a minimal version doc and defaults attachmentRefs to []", () => {
    const parsed = contentVersionDocSchema.parse({ uid: "v1", versionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", createdByUserRef: "user-ref-1" });
    expect(parsed.attachmentRefs).toEqual([]);
    expect(parsed.captionText).toBeNull();
  });

  it("round-trips a fully populated version doc", () => {
    const parsed = contentVersionDocSchema.parse({
      uid: "v2",
      versionNumber: 2,
      captionText: "A caption",
      sourceUrl: "https://example.com/raw.mp4",
      submissionNotes: "Ready.",
      attachmentRefs: ["att-1", "att-2"],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdByUserRef: "user-ref-1",
    });
    expect(parsed.attachmentRefs).toEqual(["att-1", "att-2"]);
  });

  it("rejects an unrecognized field (strict schema)", () => {
    expect(() =>
      contentVersionDocSchema.parse({ uid: "v1", versionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", createdByUserRef: "user-ref-1", extra: "nope" }),
    ).toThrow();
  });
});

describe("publicationEvidenceItemSchema", () => {
  it("round-trips a minimal evidence item and defaults optional fields", () => {
    const parsed = publicationEvidenceItemSchema.parse({
      evidenceId: "e1",
      platform: "instagram",
      originalUrl: "https://instagram.com/p/abc",
      normalizedUrl: "https://instagram.com/p/abc",
      recordedAt: "2026-01-01T00:00:00.000Z",
      recordedByUserRef: "user-ref-1",
    });
    expect(parsed.platformContentId).toBeNull();
    expect(parsed.provenance).toBe("STAFF_RECORDED");
    expect(parsed.sourceExternalSubmissionRef).toBeNull();
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

describe("contentRequiredSlotClaimDocSchema", () => {
  it("round-trips CLAIMED and RELEASED states", () => {
    const claimed = contentRequiredSlotClaimDocSchema.parse({
      assignmentRef: "assignment-ref-1",
      slotIndex: 0,
      contentRef: "content-ref-1",
      contentUid: "content-uid-1",
      state: "CLAIMED",
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(claimed.state).toBe("CLAIMED");
    expect(claimed.releasedAt).toBeNull();

    const released = contentRequiredSlotClaimDocSchema.parse({
      assignmentRef: "assignment-ref-1",
      slotIndex: 0,
      contentRef: "content-ref-1",
      contentUid: "content-uid-1",
      state: "RELEASED",
      claimedAt: "2026-01-01T00:00:00.000Z",
      releasedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(released.releasedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("contentPublicationClaimDocSchema", () => {
  it("round-trips a claim doc", () => {
    const parsed = contentPublicationClaimDocSchema.parse({
      key: "url:instagram:https://instagram.com/p/abc",
      contentRef: "content-ref-1",
      contentUid: "content-uid-1",
      evidenceId: "evidence-1",
      claimedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.key).toBe("url:instagram:https://instagram.com/p/abc");
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

describe("publicationUrlIdentityKey / publicationContentIdIdentityKey", () => {
  it("composes a namespaced, platform-scoped key", () => {
    expect(publicationUrlIdentityKey("instagram", "https://instagram.com/p/abc")).toBe("url:instagram:https://instagram.com/p/abc");
    expect(publicationContentIdIdentityKey("youtube", "abc123")).toBe("pcid:youtube:abc123");
  });

  it("the same normalized URL under a different platform is a different identity", () => {
    const a = publicationUrlIdentityKey("instagram", "https://example.com/x");
    const b = publicationUrlIdentityKey("youtube", "https://example.com/x");
    expect(a).not.toBe(b);
  });
});

describe("contentRequiredSlotClaimDocId", () => {
  it("composes a deterministic assignmentRef:slotIndex id", () => {
    expect(contentRequiredSlotClaimDocId("assignment-ref-1", 0)).toBe("assignment-ref-1:0");
    expect(contentRequiredSlotClaimDocId("assignment-ref-1", 3)).toBe("assignment-ref-1:3");
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
