import { describe, expect, it } from "vitest";

import { buildCreateAssignmentInput, distinctNormalizedPlatforms, EMPTY_CREATE_ASSIGNMENT_FORM, parseCommaList, parseHashtags, type CreateAssignmentFormValues } from "./create-assignment-form";

const ACCOUNTS = [{ partnerAccountRef: "pa-1", platform: "Instagram" }];

function build(values: Partial<CreateAssignmentFormValues> = {}, accounts = ACCOUNTS) {
  return buildCreateAssignmentInput({ campaignRef: "camp-1", partnerRef: "partner-1", selectedAccounts: accounts, values: { ...EMPTY_CREATE_ASSIGNMENT_FORM, ...values } });
}

describe("parseCommaList (formats)", () => {
  it("trims, drops blanks and de-duplicates case-insensitively keeping the first spelling", () => {
    expect(parseCommaList(" Reel, Story ,, reel ,  ")).toEqual(["Reel", "Story"]);
    expect(parseCommaList("")).toEqual([]);
  });
});

describe("parseHashtags", () => {
  it("strips leading #, splits on commas and whitespace, and de-duplicates", () => {
    expect(parseHashtags("#Launch, launch  #Sale ##Deal,,")).toEqual(["Launch", "Sale", "Deal"]);
    expect(parseHashtags("   ")).toEqual([]);
    expect(parseHashtags("#")).toEqual([]);
  });
});

describe("distinctNormalizedPlatforms", () => {
  it("uses the shared normalizer and returns each platform once (multiple accounts, same platform)", () => {
    expect(distinctNormalizedPlatforms([{ platform: "Instagram" }, { platform: " instagram " }, { platform: "YouTube" }])).toEqual(["instagram", "youtube"]);
  });
});

describe("buildCreateAssignmentInput", () => {
  it("requires at least one selected Partner Account", () => {
    const result = build({}, []);
    expect(result).toEqual({ ok: false, errors: ["Select at least one Partner Account."] });
  });

  it("builds a minimal valid payload: campaign, partner, accounts and derived platforms only", () => {
    const result = build();
    expect(result).toEqual({ ok: true, input: { campaignRef: "camp-1", partnerRef: "partner-1", partnerAccountRefs: ["pa-1"], brief: { platforms: ["instagram"] } } });
  });

  it("maps every supported field and omits empty ones", () => {
    const result = build({
      instructions: "  Post twice.  ",
      contentRequirementSummary: "Two reels",
      requiredCount: "2",
      formats: "Reel, Story",
      dueAt: "2026-12-01",
      language: "Malayalam",
      hashtags: "#Launch, sale",
      resourceLinks: [
        { label: "Brief", url: "https://example.com/brief.pdf", shareExternally: true },
        { label: "", url: "", shareExternally: false }, // untouched blank row is skipped
      ],
    });
    expect(result).toEqual({
      ok: true,
      input: {
        campaignRef: "camp-1",
        partnerRef: "partner-1",
        partnerAccountRefs: ["pa-1"],
        brief: {
          platforms: ["instagram"],
          instructions: "Post twice.",
          contentRequirementSummary: "Two reels",
          requiredCount: 2,
          formats: ["Reel", "Story"],
          language: "Malayalam",
          hashtags: ["Launch", "sale"],
          dueAt: "2026-12-01",
          resourceLinks: [{ label: "Brief", url: "https://example.com/brief.pdf", shareExternally: true }],
        },
      },
    });
  });

  it("never sends an owner, review policy or any Campaign-derived field", () => {
    const result = build({ instructions: "x" });
    if (!result.ok) throw new Error("unreachable");
    const serialized = JSON.stringify(result.input);
    for (const forbidden of ["owner", "reviewPolicy", "campaignName", "campaignObjective", "agreement", "payable", "targetAudience"]) expect(serialized).not.toContain(forbidden);
  });

  it("defaults shareExternally to false for a new link row", () => {
    const result = build({ resourceLinks: [{ label: "Ref", url: "https://example.com", shareExternally: false }] });
    if (!result.ok) throw new Error("unreachable");
    expect(result.input.brief?.resourceLinks?.[0]?.shareExternally).toBe(false);
  });

  it("rejects non-http(s) resource link URLs and incomplete rows", () => {
    expect(build({ resourceLinks: [{ label: "Bad", url: "javascript:alert(1)", shareExternally: false }] })).toMatchObject({ ok: false });
    expect(build({ resourceLinks: [{ label: "Bad", url: "example.com", shareExternally: false }] })).toMatchObject({ ok: false });
    expect(build({ resourceLinks: [{ label: "", url: "https://example.com", shareExternally: false }] })).toMatchObject({ ok: false });
    expect(build({ resourceLinks: [{ label: "No URL", url: "", shareExternally: false }] })).toMatchObject({ ok: false });
  });

  it("validates required count (whole number 1..1000), due date shape and length bounds", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1001"]) expect(build({ requiredCount: bad })).toMatchObject({ ok: false });
    expect(build({ requiredCount: "1000" })).toMatchObject({ ok: true });
    expect(build({ dueAt: "12/01/2026" })).toMatchObject({ ok: false });
    expect(build({ instructions: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect(build({ contentRequirementSummary: "x".repeat(1001) })).toMatchObject({ ok: false });
    expect(build({ hashtags: Array.from({ length: 31 }, (_, i) => `tag${i}`).join(",") })).toMatchObject({ ok: false });
    expect(build({ formats: Array.from({ length: 21 }, (_, i) => `f${i}`).join(",") })).toMatchObject({ ok: false });
  });
});
