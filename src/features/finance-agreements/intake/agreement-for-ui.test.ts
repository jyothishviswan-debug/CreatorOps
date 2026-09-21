import { describe, expect, it } from "vitest";

import type { CounterpartyPartnerAccountDto } from "@/server/finance-agreements/workspace-dto";

import {
  accountLabel,
  choiceCounterpartyType,
  EMPTY_AGREEMENT_FOR,
  evaluateAgreementFor,
  radioKeyTarget,
  searchResultToOption,
  selectAccount,
  selectChoice,
  selectCounterparty,
  selectScope,
  type AgreementForState,
} from "./agreement-for-ui";

const account = (over: Partial<CounterpartyPartnerAccountDto> & { partnerAccountRef: string; platform: string }): CounterpartyPartnerAccountDto => ({ handle: null, displayName: null, profileUrl: null, status: "ACTIVE", primary: false, ...over });
const IG1 = account({ partnerAccountRef: "pa_ig1", platform: "instagram", handle: "asha.ig", primary: true });
const IG2 = account({ partnerAccountRef: "pa_ig2", platform: "instagram", handle: "asha.two" });
const YT1 = account({ partnerAccountRef: "pa_yt1", platform: "youtube", handle: "@ashatv" });
const picked = { id: "prt_1", label: "Asha Rao" };

describe("deep-link preselection (regression: the first card click used to drop the preselected counterparty)", () => {
  const deepLink: AgreementForState = { ...EMPTY_AGREEMENT_FOR, counterparty: picked, preselectedType: "PARTNER" };

  it("keeps a preselected Partner when a Partner card is chosen", () => {
    const state = selectChoice(deepLink, "YOUTUBE_PARTNER");
    expect(state.counterparty).toEqual(picked);
    expect(state.preselectedType).toBeNull();
  });

  it("drops a preselected Partner when the Vendor card is chosen", () => {
    expect(selectChoice(deepLink, "VENDOR").counterparty).toBeNull();
  });

  it("without a preselection the first card starts with no counterparty", () => {
    expect(selectChoice(EMPTY_AGREEMENT_FOR, "INSTAGRAM_PARTNER").counterparty).toBeNull();
  });
});

describe("Agreement-for state transitions", () => {
  it("maps the four cards to a counterparty type", () => {
    expect(choiceCounterpartyType("INSTAGRAM_PARTNER")).toBe("PARTNER");
    expect(choiceCounterpartyType("YOUTUBE_PARTNER")).toBe("PARTNER");
    expect(choiceCounterpartyType("IG_YT_PARTNER")).toBe("PARTNER");
    expect(choiceCounterpartyType("VENDOR")).toBe("VENDOR");
    expect(choiceCounterpartyType(null)).toBeNull();
  });

  it("keeps the ONE Partner when only the platform choice changes, but forgets the account picks", () => {
    let state: AgreementForState = selectChoice(EMPTY_AGREEMENT_FOR, "INSTAGRAM_PARTNER");
    state = selectCounterparty(state, picked);
    state = selectScope(state, "ACCOUNT_SPECIFIC", [IG1, YT1]);
    expect(state.selection.instagram).toBe("pa_ig1");
    state = selectChoice(state, "IG_YT_PARTNER");
    expect(state.counterparty).toEqual(picked);
    expect(state.selection).toEqual({});
    expect(state.scope).toBe("ACCOUNT_SPECIFIC");
  });

  it("drops the counterparty and scope when moving between a Partner and a Vendor", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "YOUTUBE_PARTNER"), picked);
    state = selectScope(state, "PARTNER_LEVEL", []);
    state = selectChoice(state, "VENDOR");
    expect(state.counterparty).toBeNull();
    expect(state.scope).toBeNull();
    state = selectCounterparty(state, { id: "vnd_1", label: "Acme" });
    state = selectChoice(state, "INSTAGRAM_PARTNER");
    expect(state.counterparty).toBeNull();
  });

  it("selecting the same choice is a no-op", () => {
    const state = selectChoice(EMPTY_AGREEMENT_FOR, "VENDOR");
    expect(selectChoice(state, "VENDOR")).toBe(state);
  });

  it("forgets the account picks when a different counterparty is chosen", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "INSTAGRAM_PARTNER"), picked);
    state = selectAccount(state, "instagram", "pa_ig2");
    expect(selectCounterparty(state, { id: "prt_2", label: "Other" }).selection).toEqual({});
    expect(selectCounterparty(state, picked).selection).toEqual({ instagram: "pa_ig2" });
  });

  it("suggests a single eligible account per platform but never picks among several", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "IG_YT_PARTNER"), picked);
    state = selectScope(state, "ACCOUNT_SPECIFIC", [IG1, IG2, YT1]);
    expect(state.selection).toEqual({ youtube: "pa_yt1" });
    state = selectScope(state, "PARTNER_LEVEL", [IG1, IG2, YT1]);
    expect(state.selection).toEqual({});
  });
});

describe("Agreement-for evaluation (what Start draft sends)", () => {
  it("needs a choice, a counterparty and (Partner) an explicit scope", () => {
    expect(evaluateAgreementFor(EMPTY_AGREEMENT_FOR, null).ok).toBe(false);
    const withChoice = selectChoice(EMPTY_AGREEMENT_FOR, "INSTAGRAM_PARTNER");
    expect(evaluateAgreementFor(withChoice, null)).toMatchObject({ ok: false, issues: [{ code: "counterparty_required" }] });
    const withPartner = selectCounterparty(withChoice, picked);
    expect(evaluateAgreementFor(withPartner, [IG1])).toMatchObject({ ok: false, issues: [{ code: "scope_required" }] });
  });

  it("Partner-level sends no accounts and records the platforms through the platforms field", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "IG_YT_PARTNER"), picked);
    state = selectScope(state, "PARTNER_LEVEL", [IG1, YT1]);
    const result = evaluateAgreementFor(state, [IG1, YT1]);
    expect(result).toMatchObject({ ok: true, counterparty: { type: "PARTNER", partnerRef: "prt_1" }, recordPlatformsField: ["instagram", "youtube"] });
    if (result.ok && result.counterparty.type === "PARTNER") expect(result.counterparty.partnerAccountRefs).toBeUndefined();
  });

  it("Account-specific requires a deliberate pick per platform when several accounts exist", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "IG_YT_PARTNER"), picked);
    state = selectScope(state, "ACCOUNT_SPECIFIC", [IG1, IG2, YT1]);
    const incomplete = evaluateAgreementFor(state, [IG1, IG2, YT1]);
    expect(incomplete).toMatchObject({ ok: false, issues: [{ code: "account_required", platform: "instagram" }] });
    state = selectAccount(state, "instagram", "pa_ig2");
    const done = evaluateAgreementFor(state, [IG1, IG2, YT1]);
    expect(done).toMatchObject({ ok: true, recordPlatformsField: null, counterparty: { type: "PARTNER", partnerRef: "prt_1", partnerAccountRefs: ["pa_ig2", "pa_yt1"] } });
  });

  it("refuses an Account-specific Agreement for a platform with no active account, and an account not on the Partner", () => {
    let state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "YOUTUBE_PARTNER"), picked);
    state = selectScope(state, "ACCOUNT_SPECIFIC", [IG1]);
    expect(evaluateAgreementFor(state, [IG1])).toMatchObject({ ok: false, issues: [{ code: "no_account_for_platform", platform: "youtube" }] });
    state = selectAccount({ ...state, selection: {} }, "youtube", "pa_someone_else");
    expect(evaluateAgreementFor(state, [YT1])).toMatchObject({ ok: false, issues: [{ code: "account_not_eligible" }] });
  });

  it("a Vendor names the Vendor only - no accounts, no platforms, no represented Partner", () => {
    const state = selectCounterparty(selectChoice(EMPTY_AGREEMENT_FOR, "VENDOR"), { id: "vnd_1", label: "Acme" });
    expect(evaluateAgreementFor(state, null)).toEqual({ ok: true, counterpartyType: "VENDOR", counterparty: { type: "VENDOR", vendorRef: "vnd_1" }, platforms: [], recordPlatformsField: null });
  });
});

describe("card radio keyboard", () => {
  it("moves with arrows (wrapping), Home and End; ignores other keys", () => {
    expect(radioKeyTarget("ArrowRight", 0, 4)).toBe(1);
    expect(radioKeyTarget("ArrowDown", 3, 4)).toBe(0);
    expect(radioKeyTarget("ArrowLeft", 0, 4)).toBe(3);
    expect(radioKeyTarget("ArrowUp", 2, 4)).toBe(1);
    expect(radioKeyTarget("Home", 2, 4)).toBe(0);
    expect(radioKeyTarget("End", 0, 4)).toBe(3);
    expect(radioKeyTarget("Enter", 0, 4)).toBeNull();
    expect(radioKeyTarget("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("display helpers", () => {
  it("shows the handle first and never identifies an account by display name alone", () => {
    expect(accountLabel(IG1)).toEqual({ title: "@asha.ig", detail: "Primary account" });
    expect(accountLabel(YT1).title).toBe("@ashatv");
    expect(accountLabel(account({ partnerAccountRef: "pa_x", platform: "instagram", handle: "h", displayName: "Asha" }))).toEqual({ title: "@h", detail: "Asha" });
    expect(accountLabel(account({ partnerAccountRef: "pa_y", platform: "instagram", displayName: "Only Name" })).title).toBe("Only Name");
  });
  it("maps a search result to a combobox option with regions as the hint", () => {
    expect(searchResultToOption({ type: "PARTNER", ref: "prt_1", displayName: "Asha Rao", regions: ["Kerala", "Tamil Nadu"], status: "ACTIVE" })).toEqual({ id: "prt_1", label: "Asha Rao", description: "Kerala, Tamil Nadu" });
    expect(searchResultToOption({ type: "VENDOR", ref: "vnd_1", displayName: "Acme", regions: [], status: "ACTIVE" }).description).toBeUndefined();
  });
});
