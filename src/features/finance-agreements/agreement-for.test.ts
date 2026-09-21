import { describe, expect, it } from "vitest";

import type { CounterpartyPartnerAccountDto } from "@/server/finance-agreements/workspace-dto";

import { AGREEMENT_FOR_OPTIONS, agreementForOption, buildAgreementFor, counterpartyInputKey, groupAccountsByPlatform, resolveAgreementFor, suggestedAccountSelection } from "./agreement-for";

const account = (overrides: Partial<CounterpartyPartnerAccountDto> & { partnerAccountRef: string; platform: string }): CounterpartyPartnerAccountDto => ({
  handle: null,
  displayName: null,
  profileUrl: null,
  status: "ACTIVE",
  primary: false,
  ...overrides,
});

const IG_1 = account({ partnerAccountRef: "pa_ig1", platform: "instagram", handle: "@zed", primary: true });
const IG_2 = account({ partnerAccountRef: "pa_ig2", platform: "instagram", handle: "@alpha" });
const IG_OLD = account({ partnerAccountRef: "pa_igold", platform: "instagram", handle: "@old", status: "INACTIVE" });
const YT_1 = account({ partnerAccountRef: "pa_yt1", platform: "youtube", displayName: "Zed TV" });

describe("the four `Agreement for` choices", () => {
  it("are exactly Instagram Partner, YouTube Partner, Instagram + YouTube Partner, Vendor - in that order", () => {
    expect(AGREEMENT_FOR_OPTIONS.map((option) => option.label)).toEqual(["Instagram Partner", "YouTube Partner", "Instagram + YouTube Partner", "Vendor"]);
    expect(AGREEMENT_FOR_OPTIONS.map((option) => option.value)).toEqual(["INSTAGRAM_PARTNER", "YOUTUBE_PARTNER", "IG_YT_PARTNER", "VENDOR"]);
  });

  it("map onto the canonical model: ONE Partner + platform scope, or a Vendor (never separate platform Partner entities)", () => {
    expect(resolveAgreementFor("INSTAGRAM_PARTNER")).toEqual({ counterpartyType: "PARTNER", platforms: ["instagram"] });
    expect(resolveAgreementFor("YOUTUBE_PARTNER")).toEqual({ counterpartyType: "PARTNER", platforms: ["youtube"] });
    expect(resolveAgreementFor("IG_YT_PARTNER")).toEqual({ counterpartyType: "PARTNER", platforms: ["instagram", "youtube"] });
    expect(resolveAgreementFor("VENDOR")).toEqual({ counterpartyType: "VENDOR", platforms: [] });
    expect(new Set(AGREEMENT_FOR_OPTIONS.map((option) => option.counterpartyType))).toEqual(new Set(["PARTNER", "VENDOR"]));
  });

  it("hands out copies so a caller cannot mutate the registry", () => {
    resolveAgreementFor("IG_YT_PARTNER").platforms.push("x");
    expect(resolveAgreementFor("IG_YT_PARTNER").platforms).toEqual(["instagram", "youtube"]);
    expect(agreementForOption("VENDOR").label).toBe("Vendor");
  });
});

describe("groupAccountsByPlatform", () => {
  it("lists ACTIVE accounts per covered platform, primary first then by handle, and counts inactive ones", () => {
    const [instagram, youtube] = groupAccountsByPlatform(["instagram", "youtube"], [IG_OLD, IG_2, IG_1, YT_1]);
    expect(instagram!.platformLabel).toBe("Instagram");
    expect(instagram!.eligible.map((a) => a.partnerAccountRef)).toEqual(["pa_ig1", "pa_ig2"]);
    expect(instagram!.inactiveCount).toBe(1);
    expect(instagram!.requiresChoice).toBe(true);
    expect(instagram!.missing).toBe(false);
    expect(youtube!.platformLabel).toBe("YouTube");
    expect(youtube!.eligible.map((a) => a.partnerAccountRef)).toEqual(["pa_yt1"]);
    expect(youtube!.requiresChoice).toBe(false);
  });

  it("ignores accounts on platforms the choice does not cover, and reports a platform with none as missing", () => {
    const [instagram] = groupAccountsByPlatform(["instagram"], [YT_1]);
    expect(instagram!.eligible).toEqual([]);
    expect(instagram!.missing).toBe(true);
    expect(groupAccountsByPlatform(["instagram"], [IG_OLD])[0]!.missing).toBe(true);
  });

  it("normalizes platform identifiers (case / whitespace)", () => {
    const [group] = groupAccountsByPlatform([" Instagram "], [account({ partnerAccountRef: "pa_x", platform: "INSTAGRAM" })]);
    expect(group!.platform).toBe("instagram");
    expect(group!.eligible).toHaveLength(1);
  });
});

describe("suggestedAccountSelection - never choose for the person when there is a real choice", () => {
  it("pre-selects only a platform with exactly one eligible account", () => {
    const groups = groupAccountsByPlatform(["instagram", "youtube"], [IG_1, IG_2, YT_1]);
    expect(suggestedAccountSelection(groups)).toEqual({ youtube: "pa_yt1" });
  });
});

describe("buildAgreementFor", () => {
  const partnerInput = (over: Partial<Parameters<typeof buildAgreementFor>[0]> = {}) => ({ choice: "INSTAGRAM_PARTNER" as const, counterpartyRef: "p_1", scope: "ACCOUNT_SPECIFIC" as const, selection: {}, accounts: [IG_1] as readonly CounterpartyPartnerAccountDto[], ...over });

  it("needs a choice, then a counterparty", () => {
    expect(buildAgreementFor(partnerInput({ choice: null }))).toMatchObject({ ok: false, issues: [{ code: "counterparty_required" }] });
    expect(buildAgreementFor(partnerInput({ counterpartyRef: null }))).toMatchObject({ ok: false, issues: [{ code: "counterparty_required", message: "Search for and choose a Partner." }] });
    expect(buildAgreementFor({ choice: "VENDOR", counterpartyRef: null, scope: null, selection: {}, accounts: [] })).toMatchObject({ ok: false, issues: [{ message: "Search for and choose a Vendor." }] });
  });

  it("a Vendor names the Vendor only - no accounts, no platforms, no inferred Partner", () => {
    expect(buildAgreementFor({ choice: "VENDOR", counterpartyRef: "v_1", scope: null, selection: { instagram: "x" }, accounts: [IG_1] })).toEqual({
      ok: true,
      counterpartyType: "VENDOR",
      counterparty: { type: "VENDOR", vendorRef: "v_1" },
      platforms: [],
      recordPlatformsField: null,
    });
  });

  it("a Partner must explicitly choose Account-specific or Partner-level", () => {
    expect(buildAgreementFor(partnerInput({ scope: null }))).toMatchObject({ ok: false, issues: [{ code: "scope_required" }] });
  });

  it("Partner-level: no account refs are sent and the intended platforms are recorded through the `platforms` field", () => {
    const result = buildAgreementFor(partnerInput({ choice: "IG_YT_PARTNER", scope: "PARTNER_LEVEL", accounts: [] }));
    expect(result).toEqual({
      ok: true,
      counterpartyType: "PARTNER",
      counterparty: { type: "PARTNER", partnerRef: "p_1" },
      platforms: ["instagram", "youtube"],
      recordPlatformsField: ["instagram", "youtube"],
    });
    expect(JSON.stringify(result)).not.toContain("partnerAccountRefs");
  });

  it("Account-specific: one deliberately chosen account per selected platform", () => {
    const result = buildAgreementFor(partnerInput({ choice: "IG_YT_PARTNER", accounts: [IG_1, IG_2, YT_1], selection: { instagram: "pa_ig2", youtube: "pa_yt1" } }));
    expect(result).toEqual({
      ok: true,
      counterpartyType: "PARTNER",
      counterparty: { type: "PARTNER", partnerRef: "p_1", partnerAccountRefs: ["pa_ig2", "pa_yt1"] },
      platforms: ["instagram", "youtube"],
      recordPlatformsField: null,
    });
    // the request body is strict: it never carries platformScope / status / uids
    expect(Object.keys((result as { counterparty: object }).counterparty).sort()).toEqual(["partnerAccountRefs", "partnerRef", "type"]);
  });

  it("Account-specific with several accounts on a platform: the person MUST pick (no default, no match by display name)", () => {
    const result = buildAgreementFor(partnerInput({ accounts: [IG_1, IG_2], selection: {} }));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "account_required", platform: "instagram", message: "Choose the Instagram account this Agreement covers." }] });
  });

  it("Account-specific for two platforms reports every platform still missing a choice", () => {
    const result = buildAgreementFor(partnerInput({ choice: "IG_YT_PARTNER", accounts: [IG_1, YT_1], selection: { instagram: "pa_ig1" } }));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "account_required", platform: "youtube" }] });
  });

  it("Account-specific with no active account on a platform cannot proceed (choose Partner-level or add the account first)", () => {
    const result = buildAgreementFor(partnerInput({ choice: "IG_YT_PARTNER", accounts: [IG_1], selection: { instagram: "pa_ig1" } }));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "no_account_for_platform", platform: "youtube" }] });
  });

  it("rejects a selected account that is inactive, on another platform, or not the Partner's", () => {
    for (const chosen of ["pa_igold", "pa_yt1", "pa_someone_else"]) {
      const result = buildAgreementFor(partnerInput({ accounts: [IG_1, IG_OLD, YT_1], selection: { instagram: chosen } }));
      expect(result).toMatchObject({ ok: false, issues: [{ code: "account_not_eligible", platform: "instagram" }] });
    }
  });
});

describe("counterpartyInputKey - a different counterparty or account set means a NEW draft", () => {
  it("is stable for the same input regardless of account order, and differs otherwise", () => {
    const a = counterpartyInputKey({ type: "PARTNER", partnerRef: "p_1", partnerAccountRefs: ["b", "a"] });
    expect(counterpartyInputKey({ type: "PARTNER", partnerRef: "p_1", partnerAccountRefs: ["a", "b"] })).toBe(a);
    expect(counterpartyInputKey({ type: "PARTNER", partnerRef: "p_1" })).not.toBe(a);
    expect(counterpartyInputKey({ type: "PARTNER", partnerRef: "p_2", partnerAccountRefs: ["a", "b"] })).not.toBe(a);
    expect(counterpartyInputKey({ type: "VENDOR", vendorRef: "p_1" })).not.toBe(counterpartyInputKey({ type: "PARTNER", partnerRef: "p_1" }));
  });
});
