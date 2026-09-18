import { describe, expect, it } from "vitest";

import { buildWhatsAppDeepLink, buildWhatsAppShareMessage } from "./whatsapp";

// Step 10C section 16: pure, no-Firestore, no-token coverage for the one
// safe message-composition helper - never creates a session, never
// requires a token.
describe("buildWhatsAppShareMessage", () => {
  it("produces a brief-only message with no URL when submissionUrl is omitted", () => {
    const message = buildWhatsAppShareMessage({
      campaignName: "Civic Voices",
      partnerDisplayName: "Meera Krishnan",
      dueAt: "2026-12-01",
      platforms: ["instagram", "youtube"],
      summary: "One reel + one static carousel.",
    });
    expect(message).toContain("Civic Voices");
    expect(message).toContain("Assignment for Meera Krishnan");
    expect(message).toContain("Due: 2026-12-01");
    expect(message).toContain("Platforms: Instagram, Youtube");
    expect(message).toContain("One reel + one static carousel.");
    expect(message).not.toContain("http");
    expect(message).not.toContain("Submit published links");
  });

  it("includes the URL only when explicitly passed", () => {
    const message = buildWhatsAppShareMessage({
      campaignName: "Civic Voices",
      partnerDisplayName: null,
      dueAt: null,
      platforms: [],
      summary: null,
      submissionUrl: "https://creatorops.example/submit/abc123",
    });
    expect(message).toContain("Submit published links: https://creatorops.example/submit/abc123");
  });

  it("omits optional lines that have no value, never fabricating a partner/date/platform", () => {
    const message = buildWhatsAppShareMessage({ campaignName: "X", partnerDisplayName: null, dueAt: null, platforms: [], summary: null });
    expect(message).toBe("X");
  });
});

describe("buildWhatsAppDeepLink", () => {
  it("builds a wa.me click-to-chat URL with the message URL-encoded", () => {
    const deepLink = buildWhatsAppDeepLink("hello world");
    expect(deepLink).toBe("https://wa.me/?text=hello%20world");
  });
});
