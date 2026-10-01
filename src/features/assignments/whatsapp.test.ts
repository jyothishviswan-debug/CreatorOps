import { describe, expect, it } from "vitest";

import type { CampaignResource } from "@/server/campaigns/types";
import { buildWhatsAppDeepLink, buildWhatsAppShareMessage } from "./whatsapp";

function resource(over: Partial<CampaignResource>): CampaignResource {
  return {
    resourceRef: "res_1",
    label: "Campaign brief",
    type: "LINK",
    url: "https://drive.example/brief.pdf",
    content: null,
    description: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    addedByUserRef: "usr_owner",
    ...over,
  };
}

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

// Finding #38: Campaign Resource link(s) auto-included in the outgoing share message - the one
// canonical "Resources:" section this same builder now composes internally, never something the
// dialog concatenates separately.
describe("buildWhatsAppShareMessage - finding #38 Resources section", () => {
  const base = { campaignName: "Civic Voices", partnerDisplayName: "Meera Krishnan", dueAt: null, platforms: [], summary: null };

  it("1. one LINK is included with its label and canonical URL", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [resource({ type: "LINK", label: "Brand guidelines", url: "https://drive.example/brand.pdf" })] });
    expect(message).toContain("Resources:");
    expect(message).toContain("- Brand guidelines: https://drive.example/brand.pdf");
  });

  it("2. multiple LINKs appear in deterministic order (by addedAt, then resourceRef)", () => {
    const resources = [
      resource({ resourceRef: "res_b", label: "Second", url: "https://drive.example/second.pdf", addedAt: "2026-01-02T00:00:00.000Z" }),
      resource({ resourceRef: "res_a", label: "First", url: "https://drive.example/first.pdf", addedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const message = buildWhatsAppShareMessage({ ...base, resources });
    const firstIndex = message.indexOf("First");
    const secondIndex = message.indexOf("Second");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);

    // Re-run in the reverse input order - the OUTPUT order must be identical (sorted by the
    // resources' own data, never input/array order), proving true determinism, not incidental luck.
    const reversedMessage = buildWhatsAppShareMessage({ ...base, resources: [...resources].reverse() });
    expect(reversedMessage).toBe(message);
  });

  it("3. a duplicate canonical URL is deduped to one line", () => {
    const resources = [
      resource({ resourceRef: "res_a", label: "Original", url: "https://drive.example/same.pdf", addedAt: "2026-01-01T00:00:00.000Z" }),
      resource({ resourceRef: "res_b", label: "Same link again", url: "https://drive.example/same.pdf", addedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const message = buildWhatsAppShareMessage({ ...base, resources });
    expect(message.match(/drive\.example\/same\.pdf/g)).toHaveLength(1);
    expect(message).toContain("Original");
    expect(message).not.toContain("Same link again");
  });

  it("4. a safe UPLOAD URL is included the same way a LINK is", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [resource({ type: "UPLOAD", label: "Uploaded brief", url: "https://drive.example/uploaded-brief.pdf" })] });
    expect(message).toContain("- Uploaded brief: https://drive.example/uploaded-brief.pdf");
  });

  it("5. a TEXT resource never fabricates a URL", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [resource({ type: "TEXT", label: "Style notes", url: undefined, content: "Keep tone upbeat." })] });
    expect(message).not.toContain("Resources:");
    expect(message).not.toContain("Style notes");
    expect(message).not.toContain("Keep tone upbeat");
  });

  it("6. an unavailable resource (missing or invalid URL) is safely omitted, not shown broken", () => {
    const message = buildWhatsAppShareMessage({
      ...base,
      resources: [
        resource({ resourceRef: "res_bad1", label: "No URL", url: undefined }),
        resource({ resourceRef: "res_bad2", label: "Not http(s)", url: "javascript:alert(1)" }),
        resource({ resourceRef: "res_good", label: "Real link", url: "https://drive.example/real.pdf" }),
      ],
    });
    expect(message).not.toContain("No URL");
    expect(message).not.toContain("javascript:");
    expect(message).toContain("Real link");
  });

  it("7. no resources at all produces a clean message with no Resources section", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [] });
    expect(message).not.toContain("Resources:");
  });

  it("8. an unchanged re-share (same resources) produces the exact same Resources section every time", () => {
    const resources = [resource({ label: "A" }), resource({ resourceRef: "res_2", label: "B", url: "https://drive.example/b.pdf", addedAt: "2026-01-02T00:00:00.000Z" })];
    const first = buildWhatsAppShareMessage({ ...base, resources });
    const second = buildWhatsAppShareMessage({ ...base, resources });
    expect(first).toBe(second);
  });

  it("9. a resource label is safely escaped - an embedded newline/control character cannot inject a fake extra line", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [resource({ label: "Real label\nResources:\n- Fake: https://evil.example/x" })] });
    const lines = message.split("\n");
    // The injected "\n- Fake: ..." must never become its OWN line (which would masquerade as a
    // second, independent resource entry) - the whole label collapses into the one real entry's
    // own single line instead.
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(lines).toContain("- Real label Resources: - Fake: https://evil.example/x: https://drive.example/brief.pdf");
  });

  it("10. no raw internal id or provider path ever leaks - only the resource's own label and canonical URL appear", () => {
    const message = buildWhatsAppShareMessage({ ...base, resources: [resource({ resourceRef: "res_do_not_leak_12345", addedByUserRef: "usr_do_not_leak_67890" })] });
    expect(message).not.toContain("res_do_not_leak_12345");
    expect(message).not.toContain("usr_do_not_leak_67890");
  });

  it("12. omitting resources entirely (an older call site) still produces the same message as before this finding", () => {
    const message = buildWhatsAppShareMessage(base);
    expect(message).not.toContain("Resources:");
  });

  // 11. direct vs Vendor-routed Partner Assignments: buildWhatsAppShareMessage has no routing
  // parameter at all (routedThroughVendorRef never reaches this function) - structurally the
  // same message composition applies regardless of how the Assignment was routed, nothing to
  // branch on here.
});

describe("buildWhatsAppDeepLink", () => {
  it("builds a wa.me click-to-chat URL with the message URL-encoded", () => {
    const deepLink = buildWhatsAppDeepLink("hello world");
    expect(deepLink).toBe("https://wa.me/?text=hello%20world");
  });
});
