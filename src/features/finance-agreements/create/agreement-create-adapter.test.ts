import { describe, expect, it } from "vitest";

import type { IntakeCounterparty } from "../agreement-intake-logic/intake-context";
import type { CounterpartyPartnerAccountDto } from "@/server/finance-agreements/workspace-dto";

import { accountViews, extractionUiState } from "./agreement-create-adapter";

// Final Whole-Product Certification: a real, reproduced regression in `extractionUiState` (base spec section 31).
// Reproduced live: uploading a scanned/no-text Agreement PDF genuinely ran OCR, got a real 200
// MANUAL_REVIEW_REQUIRED response from POST /api/finance/contracts/extract, and the page stayed stuck on
// "Upload the signed Agreement to see extraction results here." forever - a MANUAL_REVIEW_REQUIRED run can
// have zero fields (`classifyExtraction`'s `few_fields` / PDF-unreadable branches), so `attachable` (and
// therefore `attached`) can never become true for it, and the pre-fix code required `attached` before it would
// ever look at `runStatus` at all. Fixed by checking `runStatus === "MANUAL_REVIEW_REQUIRED"` BEFORE the
// `attached` gate - see agreement-create-adapter.ts for the full reasoning.
describe("extractionUiState", () => {
  const base = { hasArtifact: true, phase: "idle" as const, errored: false };

  it("shows manual_review immediately even when nothing was extracted to attach (the reproduced bug)", () => {
    expect(extractionUiState({ ...base, attached: false, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("manual_review");
  });

  it("still shows manual_review once attached (idempotent, not a one-shot reveal)", () => {
    expect(extractionUiState({ ...base, attached: true, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("manual_review");
  });

  it("a real EXTRACTED/PARTIAL run still stays idle in the UI until explicitly attached (unchanged behavior - proposals are not shown as final before a human confirms)", () => {
    expect(extractionUiState({ ...base, attached: false, runStatus: "EXTRACTED" })).toBe("idle");
    expect(extractionUiState({ ...base, attached: false, runStatus: "PARTIAL" })).toBe("idle");
  });

  it("EXTRACTED/PARTIAL surface their real state once attached", () => {
    expect(extractionUiState({ ...base, attached: true, runStatus: "EXTRACTED" })).toBe("complete");
    expect(extractionUiState({ ...base, attached: true, runStatus: "PARTIAL" })).toBe("partial");
  });

  it("no artifact yet, or no run yet, is idle regardless of attach state", () => {
    expect(extractionUiState({ ...base, hasArtifact: false, attached: false, runStatus: null })).toBe("idle");
    expect(extractionUiState({ ...base, hasArtifact: true, attached: false, runStatus: null })).toBe("idle");
  });

  it("an in-flight phase (uploading/extracting) or an error always wins, regardless of runStatus/attached", () => {
    expect(extractionUiState({ ...base, phase: "uploading", attached: false, runStatus: "MANUAL_REVIEW_REQUIRED" })).toBe("uploading");
    expect(extractionUiState({ ...base, phase: "extracting", attached: true, runStatus: "EXTRACTED" })).toBe("extracting");
    expect(extractionUiState({ ...base, errored: true, attached: true, runStatus: "EXTRACTED" })).toBe("error");
  });
});

// Finding #27: the Partner Accounts table on "Parties & KYC" only showed Platform + Scope, never the real
// linked account identity - accountViews now reuses the intake preview's own CounterpartyPartnerAccountDto
// (the same canonical Partner Account data, matched by ref) instead of hardcoding handle/displayName/url null.
describe("accountViews", () => {
  const counterparty: IntakeCounterparty = { type: "PARTNER", ref: "prt_1", displayName: "Test Partner", platforms: ["Instagram"], accountRefs: ["pacc_1"], mode: "account-specific" };
  const account: CounterpartyPartnerAccountDto = { partnerAccountRef: "pacc_1", platform: "instagram", handle: "realhandle", displayName: "Real Display Name", profileUrl: "https://instagram.com/realhandle", status: "ACTIVE", primary: true };

  it("a Vendor counterparty (no Partner Accounts exist at all) yields no rows", () => {
    expect(accountViews({ ...counterparty, type: "VENDOR" }, [account])).toEqual([]);
  });

  it("no accountRefs at all: Partner-level scope, one row per platform, no account identity to show", () => {
    const rows = accountViews({ ...counterparty, accountRefs: [] }, [account]);
    expect(rows).toEqual([{ id: "platform-0", platform: "Instagram", displayName: null, handle: null, url: null, partnerAccountRef: null, state: "PARTNER_LEVEL" }]);
  });

  it("an accountRef that matches a real Partner Account: real handle/displayName/profileUrl populated, never fabricated", () => {
    const rows = accountViews(counterparty, [account]);
    expect(rows).toEqual([{ id: "pacc_1", platform: "Instagram", displayName: "Real Display Name", handle: "realhandle", url: "https://instagram.com/realhandle", partnerAccountRef: "pacc_1", state: "MATCHED" }]);
  });

  it("an accountRef with no matching Partner Account yet (preview not loaded, or a stale ref): honestly null, never fabricated", () => {
    const rows = accountViews(counterparty, []);
    expect(rows).toEqual([{ id: "pacc_1", platform: "Instagram", displayName: null, handle: null, url: null, partnerAccountRef: "pacc_1", state: "MATCHED" }]);
  });

  it("multiple accountRefs stay independently distinguishable, each matched to its own real account", () => {
    const secondAccount: CounterpartyPartnerAccountDto = { partnerAccountRef: "pacc_2", platform: "youtube", handle: "secondhandle", displayName: null, profileUrl: null, status: "ACTIVE", primary: false };
    const rows = accountViews({ ...counterparty, platforms: ["Instagram", "YouTube"], accountRefs: ["pacc_1", "pacc_2"] }, [account, secondAccount]);
    expect(rows).toEqual([
      { id: "pacc_1", platform: "Instagram", displayName: "Real Display Name", handle: "realhandle", url: "https://instagram.com/realhandle", partnerAccountRef: "pacc_1", state: "MATCHED" },
      { id: "pacc_2", platform: "YouTube", displayName: null, handle: "secondhandle", url: null, partnerAccountRef: "pacc_2", state: "MATCHED" },
    ]);
  });
});
