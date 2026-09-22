import { describe, expect, it, vi } from "vitest";

import type { AgreementDetailDto } from "@/server/finance-agreements/client-dto";

import type { FinanceApiResult } from "../api-client";
import { agreementDto, draftEntry, permissionsDto } from "./intake-fixtures";
import {
  buildLocalEdit,
  CLIENT_REQUEST_ID_PATTERN,
  clientRequestIdFor,
  countLocalEdits,
  counterpartyOfAgreement,
  deriveIntakeFlags,
  describeFlush,
  findPriorConfirmedVersion,
  flushLocalEdits,
  flushOrder,
  hasLocalEdits,
  intakeHref,
  intakeRouteKey,
  isEditableVersion,
  isRedundantEdit,
  newClientRequestId,
  parseIntakeSearchParams,
  resolveEditDecision,
  withEdit,
  withoutEdit,
  type LocalEdits,
} from "./intake-logic";

const ok = (data: AgreementDetailDto): FinanceApiResult<AgreementDetailDto> => ({ ok: true, status: 200, data });

describe("edit decision resolution (mirrors applyFieldDecision)", () => {
  it("accepts a value typed where none existed, and an unchanged value", () => {
    expect(resolveEditDecision(undefined, "a")).toBe("ACCEPTED");
    expect(resolveEditDecision(draftEntry({ value: null }), "a")).toBe("ACCEPTED");
    expect(resolveEditDecision(draftEntry({ value: "a" }), "a")).toBe("ACCEPTED");
  });
  it("treats a changed value as CORRECTED, never a silent ACCEPTED", () => {
    expect(resolveEditDecision(draftEntry({ value: "a" }), "b")).toBe("CORRECTED");
    expect(resolveEditDecision(draftEntry({ value: ["instagram"] }), ["instagram", "youtube"])).toBe("CORRECTED");
    expect(resolveEditDecision(draftEntry({ value: { applicable: true, amountMinor: 100 } }), { applicable: true, amountMinor: 100 })).toBe("ACCEPTED");
  });
  it("only ever acknowledges an identity value", () => {
    expect(resolveEditDecision(draftEntry({ value: "x" }), "ABCDE1234F", "panNumber")).toBe("ACCEPTED");
    expect(buildLocalEdit("panNumber", "ABCDE1234F", undefined)).toEqual({ decision: "ACCEPTED" });
  });
  it("drops the value for NOT_APPLICABLE / UNAVAILABLE and honours an explicit decision", () => {
    expect(buildLocalEdit("remarks", "ignored", undefined, "NOT_APPLICABLE")).toEqual({ decision: "NOT_APPLICABLE" });
    expect(buildLocalEdit("remarks", "ignored", undefined, "UNAVAILABLE")).toEqual({ decision: "UNAVAILABLE" });
    expect(buildLocalEdit("remarks", "note", undefined, "CORRECTED")).toEqual({ decision: "CORRECTED", value: "note" });
    expect(buildLocalEdit("remarks", "note", undefined)).toEqual({ decision: "ACCEPTED", value: "note" });
  });
  it("recognises an edit the draft already holds", () => {
    expect(isRedundantEdit({ decision: "ACCEPTED", value: "a" }, draftEntry({ decision: "ACCEPTED", value: "a" }))).toBe(true);
    expect(isRedundantEdit({ decision: "ACCEPTED", value: "a" }, draftEntry({ decision: "PENDING", value: "a" }))).toBe(false);
    expect(isRedundantEdit({ decision: "NOT_APPLICABLE" }, draftEntry({ decision: "NOT_APPLICABLE" }))).toBe(true);
    expect(isRedundantEdit({ decision: "ACCEPTED", value: "a" }, undefined)).toBe(false);
  });
});

describe("local edit buffer", () => {
  it("adds, replaces and removes edits without mutating", () => {
    const empty: LocalEdits = {};
    const one = withEdit(empty, "remarks", { decision: "ACCEPTED", value: "x" });
    const two = withEdit(one, "remarks", { decision: "ACCEPTED", value: "y" });
    expect(empty).toEqual({});
    expect(one.remarks).toEqual({ decision: "ACCEPTED", value: "x" });
    expect(two.remarks).toEqual({ decision: "ACCEPTED", value: "y" });
    expect(hasLocalEdits(two)).toBe(true);
    expect(countLocalEdits(two)).toBe(1);
    const cleared = withoutEdit(two, "remarks");
    expect(cleared).toEqual({});
    expect(hasLocalEdits(cleared)).toBe(false);
    expect(withoutEdit(cleared, "remarks")).toBe(cleared);
  });
  it("orders a flush by the registry, not by the order the person touched fields", () => {
    let edits: LocalEdits = {};
    edits = withEdit(edits, "remarks", { decision: "ACCEPTED", value: "r" });
    edits = withEdit(edits, "currency", { decision: "ACCEPTED", value: "INR" });
    edits = withEdit(edits, "counterpartyName", { decision: "ACCEPTED", value: "n" });
    const order = flushOrder(edits);
    expect(order).toHaveLength(3);
    expect(order.indexOf("counterpartyName")).toBeLessThan(order.indexOf("currency"));
    expect(order.indexOf("currency")).toBeLessThan(order.indexOf("remarks"));
  });
});

describe("save draft flush", () => {
  const edits: LocalEdits = { counterpartyName: { decision: "ACCEPTED", value: "Asha" }, currency: { decision: "CORRECTED", value: "INR" }, remarks: { decision: "NOT_APPLICABLE" } };

  it("writes every edit sequentially, each with the docVersion the previous response returned", async () => {
    let docVersion = 10;
    const seen: Array<{ fieldKey: string; sentDocVersion: number; value?: unknown; decision: string }> = [];
    const outcome = await flushLocalEdits(edits, async (item) => {
      seen.push({ fieldKey: item.fieldKey, sentDocVersion: docVersion, decision: item.decision, ...(item.value !== undefined ? { value: item.value } : {}) });
      docVersion += 1;
      return ok(agreementDto({ docVersion }));
    });
    expect(outcome.failed).toBeNull();
    expect(outcome.saved).toHaveLength(3);
    expect(seen.map((item) => item.sentDocVersion)).toEqual([10, 11, 12]);
    expect(seen.find((item) => item.fieldKey === "remarks")).toEqual({ fieldKey: "remarks", sentDocVersion: 12, decision: "NOT_APPLICABLE" });
    expect(seen.find((item) => item.fieldKey === "currency")?.value).toBe("INR");
    expect(outcome.remaining).toEqual({});
    expect(outcome.agreement?.selectedVersion?.docVersion).toBe(13);
  });

  it("never runs two writes at once", async () => {
    let running = 0;
    let peak = 0;
    await flushLocalEdits(edits, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return ok(agreementDto());
    });
    expect(peak).toBe(1);
  });

  it("stops at the first failure: the failing edit and later ones stay buffered, earlier ones are reported saved", async () => {
    let calls = 0;
    const onSaved = vi.fn();
    const outcome = await flushLocalEdits(
      edits,
      async () => {
        calls += 1;
        if (calls === 2) return { ok: false, status: 409, kind: "stale", message: "This Agreement was changed elsewhere." } as const;
        return ok(agreementDto());
      },
      onSaved,
    );
    expect(calls).toBe(2);
    expect(outcome.saved).toHaveLength(1);
    expect(outcome.failed?.failure.kind).toBe("stale");
    expect(Object.keys(outcome.remaining)).toHaveLength(2);
    expect(outcome.remaining[outcome.failed!.fieldKey]).toBeDefined();
    expect(onSaved).toHaveBeenCalledTimes(1);
    const summary = describeFlush(outcome);
    expect(summary.tone).toBe("error");
    expect(summary.message).toMatch(/1 change was saved/);
    expect(summary.message).toMatch(/not saved yet/);
  });

  it("reports an empty flush and a clean flush honestly", async () => {
    const decide = vi.fn();
    const empty = await flushLocalEdits({}, decide);
    expect(decide).not.toHaveBeenCalled();
    expect(describeFlush(empty)).toEqual({ tone: "info", message: "Draft is up to date. There are no unsaved changes." });
    const one = await flushLocalEdits({ remarks: { decision: "ACCEPTED", value: "x" } }, async () => ok(agreementDto()));
    expect(describeFlush(one)).toEqual({ tone: "success", message: "Draft saved (1 change)." });
  });
});

describe("intake URLs", () => {
  it("builds resume, deep-link and blank hrefs", () => {
    expect(intakeHref()).toBe("/finance/agreements/new");
    expect(intakeHref({ agreementRef: "agr_1", version: 2 })).toBe("/finance/agreements/new?agreementRef=agr_1&version=2");
    expect(intakeHref({ agreementRef: "agr_1" })).toBe("/finance/agreements/new?agreementRef=agr_1");
    expect(intakeHref({ counterpartyType: "PARTNER", ref: "prt_9" })).toBe("/finance/agreements/new?counterpartyType=PARTNER&ref=prt_9");
    // a resume link wins over a deep link
    expect(intakeHref({ agreementRef: "agr_1", version: 1, counterpartyType: "VENDOR", ref: "v" })).toBe("/finance/agreements/new?agreementRef=agr_1&version=1");
  });
  it("parses only well-formed params", () => {
    expect(parseIntakeSearchParams({ counterpartyType: "PARTNER", ref: "prt_1" })).toEqual({ counterpartyType: "PARTNER", ref: "prt_1", agreementRef: null, version: null, mode: null });
    expect(parseIntakeSearchParams({ agreementRef: "agr_0123", version: "3" })).toEqual({ counterpartyType: null, ref: null, agreementRef: "agr_0123", version: 3, mode: null });
    expect(parseIntakeSearchParams({ counterpartyType: "ADMIN", ref: "a b", agreementRef: "../etc", version: "0" })).toEqual({ counterpartyType: null, ref: null, agreementRef: null, version: null, mode: null });
    expect(parseIntakeSearchParams({ version: "1.5" }).version).toBeNull();
    expect(parseIntakeSearchParams({ ref: ["prt_1", "prt_2"] }).ref).toBe("prt_1");
  });
  it("understands the create-new deep link only with a counterparty type", () => {
    expect(parseIntakeSearchParams({ counterpartyType: "PARTNER", mode: "new" })).toMatchObject({ counterpartyType: "PARTNER", mode: "new" });
    expect(parseIntakeSearchParams({ counterpartyType: "VENDOR", mode: ["new"] }).mode).toBe("new");
    expect(parseIntakeSearchParams({ mode: "new" }).mode).toBeNull();
    expect(parseIntakeSearchParams({ counterpartyType: "PARTNER", mode: "existing" }).mode).toBeNull();
    expect(intakeHref({ counterpartyType: "VENDOR", mode: "new" })).toBe("/finance/agreements/new?counterpartyType=VENDOR&mode=new");
    // a resume link still wins over the create-new link
    expect(intakeHref({ agreementRef: "agr_1", counterpartyType: "VENDOR", mode: "new" })).toBe("/finance/agreements/new?agreementRef=agr_1");
    expect(intakeRouteKey(parseIntakeSearchParams({ counterpartyType: "VENDOR", mode: "new" }))).toBe("new:VENDOR:-:new");
    expect(intakeRouteKey(parseIntakeSearchParams({ counterpartyType: "VENDOR", ref: "v1", mode: "new" }))).toBe("new:VENDOR:-:new");
  });
  it("keys the client tree by route identity", () => {
    expect(intakeRouteKey(parseIntakeSearchParams({}))).toBe("new:-:-");
    expect(intakeRouteKey(parseIntakeSearchParams({ counterpartyType: "VENDOR", ref: "v1" }))).toBe("new:VENDOR:v1");
    expect(intakeRouteKey(parseIntakeSearchParams({ agreementRef: "agr_1", version: "2" }))).toBe("resume:agr_1:2");
    expect(intakeRouteKey(parseIntakeSearchParams({ agreementRef: "agr_1" }))).toBe("resume:agr_1:open");
  });
});

describe("counterparty of a created draft", () => {
  it("derives Account-specific, Partner-level and Vendor", () => {
    expect(counterpartyOfAgreement(agreementDto({ accountRefs: ["pa_1"], platformScope: ["instagram"] }), null)).toEqual({ type: "PARTNER", ref: "prt_1", displayName: "Asha Rao", platforms: ["instagram"], accountRefs: ["pa_1"], mode: "account-specific" });
    expect(counterpartyOfAgreement(agreementDto({ accountRefs: [] }), null)?.mode).toBe("partner-level");
    expect(counterpartyOfAgreement(agreementDto({ type: "VENDOR" }), null)).toMatchObject({ type: "VENDOR", ref: "vnd_1", mode: "vendor", accountRefs: [], platforms: [] });
    expect(counterpartyOfAgreement(null, "x")).toBeNull();
  });
  it("falls back to the preview name, then the ref, when the head carries no display name", () => {
    expect(counterpartyOfAgreement(agreementDto({ displayName: null }), "Preview Name")?.displayName).toBe("Preview Name");
    expect(counterpartyOfAgreement(agreementDto({ displayName: null }), null)?.displayName).toBe("prt_1");
  });
});

describe("permission-derived UI flags", () => {
  it("offers editing only to a manager on an unconfirmed DRAFT version", () => {
    const draft = agreementDto();
    expect(deriveIntakeFlags({ permissions: permissionsDto(), counterpartyType: "PARTNER", agreement: draft })).toMatchObject({ canEdit: true, canConfirm: true, canExtract: true, readOnlyReason: null, isRevision: false });
    const viewer = deriveIntakeFlags({ permissions: permissionsDto({ canManage: false }), counterpartyType: "PARTNER", agreement: draft });
    expect(viewer).toMatchObject({ canEdit: false, canConfirm: false, canExtract: false, canManage: false });
    expect(viewer.readOnlyReason).toMatch(/view this Agreement but not edit/);
    const confirmed = deriveIntakeFlags({ permissions: permissionsDto(), counterpartyType: "PARTNER", agreement: agreementDto({ confirmed: true }) });
    expect(confirmed.canEdit).toBe(false);
    expect(confirmed.readOnlyReason).toMatch(/Create a revision/);
    const active = deriveIntakeFlags({ permissions: permissionsDto(), counterpartyType: "PARTNER", agreement: agreementDto({ status: "ACTIVE", confirmed: true }) });
    expect(active.canEdit).toBe(false);
  });
  it("marks a DRAFT above version 1 as a revision", () => {
    expect(deriveIntakeFlags({ permissions: permissionsDto(), counterpartyType: "PARTNER", agreement: agreementDto({ version: 2 }) }).isRevision).toBe(true);
  });
  it("offers Activate only when the SERVER says canActivate and the open version is confirmed", () => {
    const confirmed = agreementDto({ confirmed: true });
    expect(deriveIntakeFlags({ permissions: permissionsDto({ canActivate: true }), counterpartyType: "PARTNER", agreement: confirmed }).canActivate).toBe(true);
    expect(deriveIntakeFlags({ permissions: permissionsDto({ canActivate: false }), counterpartyType: "PARTNER", agreement: confirmed }).canActivate).toBe(false);
    expect(deriveIntakeFlags({ permissions: permissionsDto({ canActivate: true }), counterpartyType: "PARTNER", agreement: agreementDto() }).canActivate).toBe(false);
    expect(deriveIntakeFlags({ permissions: permissionsDto({ canActivate: true }), counterpartyType: "PARTNER", agreement: agreementDto({ confirmed: true, openVersion: null }) }).canActivate).toBe(false);
  });
  it("takes identity flags from the counterparty type of the Agreement", () => {
    const permissions = permissionsDto({
      canViewIdentity: false,
      byCounterpartyType: { PARTNER: { canViewIdentity: true, canManageCounterpartyKyc: true }, VENDOR: { canViewIdentity: false, canManageCounterpartyKyc: false } },
    });
    expect(deriveIntakeFlags({ permissions, counterpartyType: null, agreement: agreementDto() })).toMatchObject({ canViewIdentity: true, canManageCounterpartyKyc: true });
    expect(deriveIntakeFlags({ permissions, counterpartyType: null, agreement: agreementDto({ type: "VENDOR" }) })).toMatchObject({ canViewIdentity: false, canManageCounterpartyKyc: false });
    expect(deriveIntakeFlags({ permissions, counterpartyType: "PARTNER", agreement: null })).toMatchObject({ canEdit: false, canViewIdentity: true });
  });
  it("carries the contract-detail permission through untouched", () => {
    expect(deriveIntakeFlags({ permissions: permissionsDto({ canViewContractDetail: true }), counterpartyType: "PARTNER", agreement: null }).canViewContractDetail).toBe(true);
    expect(deriveIntakeFlags({ permissions: permissionsDto(), counterpartyType: "PARTNER", agreement: null }).canViewContractDetail).toBe(false);
  });
  it("only a DRAFT that is not confirmed is editable", () => {
    expect(isEditableVersion({ status: "DRAFT", confirmed: false })).toBe(true);
    expect(isEditableVersion({ status: "DRAFT", confirmed: true })).toBe(false);
    expect(isEditableVersion({ status: "ACTIVE", confirmed: true })).toBe(false);
    expect(isEditableVersion(null)).toBe(false);
  });
});

describe("prior confirmed version", () => {
  it("is the highest confirmed version below the selected one", () => {
    const versions = [
      { version: 1, confirmed: true },
      { version: 2, confirmed: true },
      { version: 3, confirmed: false },
    ];
    expect(findPriorConfirmedVersion(versions, 3)).toBe(2);
    expect(findPriorConfirmedVersion(versions, 2)).toBe(1);
    expect(findPriorConfirmedVersion(versions, 1)).toBeNull();
    expect(findPriorConfirmedVersion([{ version: 1, confirmed: false }, { version: 2, confirmed: false }], 2)).toBeNull();
  });
});

describe("idempotency key for draft creation", () => {
  it("mints ids the API accepts", () => {
    expect(newClientRequestId()).toMatch(CLIENT_REQUEST_ID_PATTERN);
    expect(newClientRequestId(() => 0.5)).toMatch(CLIENT_REQUEST_ID_PATTERN);
    expect(newClientRequestId()).not.toBe(newClientRequestId());
  });
  it("reuses the id for the same counterparty (retry) and mints a new one for a different counterparty", () => {
    let n = 0;
    const mint = () => `id-${(n += 1)}`;
    const first = clientRequestIdFor(null, "PARTNER:a:", mint);
    const retry = clientRequestIdFor(first, "PARTNER:a:", mint);
    expect(retry).toBe(first);
    expect(n).toBe(1);
    const other = clientRequestIdFor(first, "PARTNER:b:", mint);
    expect(other.id).toBe("id-2");
    expect(other.key).toBe("PARTNER:b:");
  });
});
