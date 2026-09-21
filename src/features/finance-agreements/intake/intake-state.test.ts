import { describe, expect, it } from "vitest";

import type { ConfirmBlockerView } from "../confirm-blockers";
import { agreementDto } from "./intake-fixtures";
import { createInitialIntakeData, failureToNotice, intakeReducer, MAX_NOTICES, pruneBlockers, type IntakeData } from "./intake-state";

const blocker: ConfirmBlockerView = { code: "field_pending", fieldKey: "currency", message: "Currency has a proposed value that needs your decision.", section: "commercial_terms", anchorId: "field-currency" };

describe("intake reducer", () => {
  it("starts empty, seeded from the server's initial state", () => {
    const empty = createInitialIntakeData();
    expect(empty).toMatchObject({ agreement: null, preview: null, extraction: null, artifact: null, reconciliation: null, kyc: null, localEdits: {}, confirmBlockers: [], notices: [], conflict: null });
    const seeded = createInitialIntakeData({ agreement: agreementDto() });
    expect(seeded.agreement?.head.agreementRef).toBe("agr_0123456789abcdef0123");
    expect(seeded.localEdits).toEqual({});
  });

  it("REPLACES the agreement with each response and clears stale blockers and the conflict", () => {
    let state: IntakeData = createInitialIntakeData({ agreement: agreementDto({ docVersion: 3 }) });
    state = intakeReducer(state, { type: "blockers", blockers: [blocker] });
    state = intakeReducer(state, { type: "conflict", message: "changed elsewhere" });
    expect(state.confirmBlockers).toHaveLength(1);
    expect(state.conflict?.message).toBe("changed elsewhere");
    const next = agreementDto({ docVersion: 4 });
    state = intakeReducer(state, { type: "agreement", agreement: next });
    expect(state.agreement).toBe(next);
    expect(state.confirmBlockers).toEqual([]);
    expect(state.conflict).toBeNull();
  });

  it("prunes only the blockers of the fields a write decided; any other write clears them all", () => {
    const other: ConfirmBlockerView = { code: "field_undecided", fieldKey: "paymentCycle", message: "Payment cycle must be decided.", section: "commercial_terms", anchorId: "field-paymentCycle" };
    const general: ConfirmBlockerView = { code: "terms_invalid", fieldKey: null, message: "Terms are incomplete.", section: "commercial_terms", anchorId: "section-commercial_terms" };
    let state: IntakeData = createInitialIntakeData({ agreement: agreementDto() });
    state = intakeReducer(state, { type: "blockers", blockers: [blocker, other, general] });
    const decided = intakeReducer(state, { type: "agreement", agreement: agreementDto({ docVersion: 4 }), decidedFieldKeys: ["currency"] });
    expect(decided.confirmBlockers.map((item) => item.code)).toEqual(["field_undecided", "terms_invalid"]);
    expect(intakeReducer(state, { type: "agreement", agreement: agreementDto({ docVersion: 4 }) }).confirmBlockers).toEqual([]);
    expect(pruneBlockers([blocker], [])).toEqual([]);
  });

  it("keeps unsaved edits beside server state: a server response never drops them", () => {
    let state = createInitialIntakeData({ agreement: agreementDto() });
    state = intakeReducer(state, { type: "setEdit", fieldKey: "remarks", edit: { decision: "ACCEPTED", value: "x" } });
    state = intakeReducer(state, { type: "agreement", agreement: agreementDto({ docVersion: 9 }) });
    expect(state.localEdits.remarks).toEqual({ decision: "ACCEPTED", value: "x" });
    state = intakeReducer(state, { type: "clearEdit", fieldKey: "remarks" });
    expect(state.localEdits).toEqual({});
    state = intakeReducer(state, { type: "setEdit", fieldKey: "currency", edit: { decision: "ACCEPTED", value: "INR" } });
    state = intakeReducer(state, { type: "clearEdits" });
    expect(state.localEdits).toEqual({});
    state = intakeReducer(state, { type: "replaceEdits", edits: { remarks: { decision: "NOT_APPLICABLE" } } });
    expect(Object.keys(state.localEdits)).toEqual(["remarks"]);
  });

  it("keeps the artifact when an extraction arrives without one, and replaces it when given", () => {
    const artifact = { artifactRef: "ca_1", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256Prefix: "abc", uploadedAt: "x", uploadedByUserRef: "u", status: "UPLOADED", counterparty: { type: "PARTNER", ref: "p" } } as const;
    let state = intakeReducer(createInitialIntakeData(), { type: "artifact", artifact });
    state = intakeReducer(state, { type: "extraction", extraction: null });
    expect(state.artifact).toBe(artifact);
    state = intakeReducer(state, { type: "extraction", extraction: null, artifact: null });
    expect(state.artifact).toBeNull();
  });

  it("replaces a notice with the same id and bounds the list", () => {
    let state = createInitialIntakeData();
    state = intakeReducer(state, { type: "notice", notice: { id: "save-draft", tone: "success", message: "Draft saved (1 change)." } });
    state = intakeReducer(state, { type: "notice", notice: { id: "save-draft", tone: "success", message: "Draft saved (2 changes)." } });
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]!.message).toBe("Draft saved (2 changes).");
    for (let index = 0; index < MAX_NOTICES + 3; index += 1) state = intakeReducer(state, { type: "notice", notice: { id: `n${index}`, tone: "info", message: `m${index}` } });
    expect(state.notices).toHaveLength(MAX_NOTICES);
    expect(state.notices[MAX_NOTICES - 1]!.id).toBe(`n${MAX_NOTICES + 2}`);
    state = intakeReducer(state, { type: "dismissNotice", id: `n${MAX_NOTICES + 2}` });
    expect(state.notices.find((notice) => notice.id === `n${MAX_NOTICES + 2}`)).toBeUndefined();
  });

  it("sets and clears the conflict banner", () => {
    let state = intakeReducer(createInitialIntakeData(), { type: "conflict", message: "changed elsewhere" });
    expect(state.conflict).toEqual({ message: "changed elsewhere" });
    state = intakeReducer(state, { type: "conflict", message: null });
    expect(state.conflict).toBeNull();
  });
});

describe("failure -> notice", () => {
  it("turns stale and conflict outcomes into a reload-latest conflict, never a silent retry", () => {
    expect(failureToNotice("x", { ok: false, status: 409, kind: "stale", message: "Changed elsewhere." })).toEqual({ notice: { id: "x", tone: "error", message: "Changed elsewhere." }, conflict: "Changed elsewhere." });
    expect(failureToNotice("x", { ok: false, status: 409, kind: "conflict", message: "No longer editable." }).conflict).toBe("No longer editable.");
  });
  it("leaves other failures as a plain error notice", () => {
    expect(failureToNotice("x", { ok: false, status: 400, kind: "invalid", message: "Bad value." }).conflict).toBeNull();
    expect(failureToNotice("x", { ok: false, status: 403, kind: "forbidden", message: "You do not have access to this." }).notice.tone).toBe("error");
  });
});
