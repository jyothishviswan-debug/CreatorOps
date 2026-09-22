import { describe, expect, it } from "vitest";

import type { AgreementDocumentDto, CounterpartyAgreementDocumentDto } from "@/server/finance-agreements/client-dto";

import {
  ACTIVATION_NEEDS_STORE_TEXT,
  STORING_TEXT,
  activationDocumentGate,
  buildCounterpartyDocumentRows,
  buildDocumentView,
  describeStoreOutcome,
  documentPanelRows,
  reviewDocumentState,
  safeDocumentLink,
  versionDocumentCell,
} from "./document-view";

const LINK = "https://drive.invalid/fake/file_1";
const doc = (over: Partial<AgreementDocumentDto>): AgreementDocumentDto => ({ status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: false, ...over });

const STORED = doc({ status: "STORED", fileName: "Signed Agreement.pdf", storedAt: "2026-09-14T10:24:00.000Z", hasLink: true, link: LINK, attemptCount: 1 });
const STORED_NO_LINK = doc({ status: "STORED", fileName: "Signed Agreement.pdf", storedAt: "2026-09-14T10:24:00.000Z", hasLink: true, attemptCount: 1 });
const PENDING = doc({ status: "PENDING", canStore: true });
const PENDING_UNCONFIRMED = doc({ status: "PENDING", canStore: false });
const FAILED = doc({ status: "FAILED", fileName: "Signed Agreement.pdf", message: "Drive is temporarily unavailable. Try again.", attemptCount: 2, canStore: true });
const NOT_CONFIGURED = doc({ status: "NOT_CONFIGURED", fileName: "Signed Agreement.pdf", message: "Drive storage not configured", attemptCount: 1, canStore: true });
const NOT_APPLICABLE = doc({ status: "NOT_APPLICABLE", message: "No new signed document for this version" });

describe("the Agreement document panel state machine", () => {
  it("STORED: file name, stored date, an `Open Agreement document` link ONLY when the server sent one, and no store button", () => {
    const view = buildDocumentView({ document: STORED, canManage: true });
    expect(view).toMatchObject({ status: "STORED", fileName: "Signed Agreement.pdf", link: LINK, onFileText: null, action: null });
    expect(view.chip).toEqual({ label: "Stored", tone: "default" });
    expect(view.storedAtText).toMatch(/^Stored \d{1,2} \w+ 2026/);
    // without the contract-detail category the DTO carries no link: a neutral "on file" line, never a link
    const neutral = buildDocumentView({ document: STORED_NO_LINK, canManage: true });
    expect(neutral.link).toBeNull();
    expect(neutral.onFileText).toBe("Agreement document on file");
  });

  it("never renders a script / data URL as a link, whatever the value", () => {
    expect(safeDocumentLink("javascript:alert(1)")).toBeNull();
    expect(safeDocumentLink("data:text/html,x")).toBeNull();
    expect(safeDocumentLink("not a url")).toBeNull();
    expect(safeDocumentLink(undefined)).toBeNull();
    expect(safeDocumentLink(LINK)).toBe(LINK);
    expect(buildDocumentView({ document: { ...STORED, link: "javascript:alert(1)" }, canManage: false }).link).toBeNull();
  });

  it("PENDING and confirmed: `Store Agreement document` to a person who may manage Agreements, nothing to anyone else", () => {
    const managed = buildDocumentView({ document: PENDING, canManage: true });
    expect(managed.action).toEqual({ kind: "store", label: "Store Agreement document", busyLabel: "Storing…" });
    expect(managed.chip.label).toBe("Not stored yet");
    expect(managed.link).toBeNull();
    expect(buildDocumentView({ document: PENDING, canManage: false }).action).toBeNull();
  });

  it("PENDING but not confirmed yet: says it is stored after confirmation and offers nothing", () => {
    const view = buildDocumentView({ document: PENDING_UNCONFIRMED, canManage: true });
    expect(view.action).toBeNull();
    expect(view.headline).toContain("after this version is confirmed");
  });

  it("FAILED: the plain server reason, nothing claimed as stored, and a Retry", () => {
    const view = buildDocumentView({ document: FAILED, canManage: true });
    expect(view.action).toEqual({ kind: "retry", label: "Retry", busyLabel: "Storing…" });
    expect(view.chip).toEqual({ label: "Storage failed", tone: "red" });
    expect(view.note).toContain("Drive is temporarily unavailable. Try again.");
    expect(view.note).toContain("Nothing was recorded as stored");
    expect(view.link).toBeNull();
    expect(buildDocumentView({ document: FAILED, canManage: false }).action).toBeNull();
  });

  it("NOT_CONFIGURED: the honest 'Drive storage not configured', retriable, never a link", () => {
    const view = buildDocumentView({ document: NOT_CONFIGURED, canManage: true });
    expect(view.chip.label).toBe("Drive storage not configured");
    expect(view.headline).toBe("Drive storage not configured.");
    expect(view.action?.kind).toBe("retry");
    expect(view.link).toBeNull();
    expect(view.storedAtText).toBeNull();
  });

  it("NOT_APPLICABLE: 'No new signed document for this version' - never the prior file, never an action or a link", () => {
    const view = buildDocumentView({ document: NOT_APPLICABLE, canManage: true });
    expect(view.headline).toBe("No new signed document for this version");
    expect(view).toMatchObject({ status: "NOT_APPLICABLE", fileName: null, link: null, action: null, storedAtText: null });
    expect(view.note).toContain("Earlier versions keep their own documents");
  });

  it("the server's `canStore` is what shows the button: a stored document never offers one, even if managed", () => {
    expect(buildDocumentView({ document: { ...STORED, canStore: true }, canManage: true }).action).toBeNull();
  });
});

describe("the result of a store / retry", () => {
  it("stored / already stored are success; failed is an error that says nothing was stored and that it can be retried", () => {
    expect(describeStoreOutcome({ outcome: "stored", document: STORED })).toEqual({ tone: "success", text: "The original signed Agreement is stored." });
    expect(describeStoreOutcome({ outcome: "already_stored", document: STORED }).tone).toBe("success");
    const failed = describeStoreOutcome({ outcome: "failed", document: FAILED });
    expect(failed.tone).toBe("error");
    expect(failed.text).toContain("not stored");
    expect(failed.text).toContain("Drive is temporarily unavailable. Try again.");
    expect(failed.text).toContain("retry");
    const notConfigured = describeStoreOutcome({ outcome: "failed", document: NOT_CONFIGURED });
    expect(notConfigured.text).toContain("Drive storage not configured.");
  });
});

describe("activation readiness mirrors the server rule", () => {
  it("a version with its own signed file is blocked until STORED, with the plain reason", () => {
    expect(activationDocumentGate(PENDING)).toEqual({ blocked: true, reason: ACTIVATION_NEEDS_STORE_TEXT });
    expect(activationDocumentGate(FAILED).reason).toContain("could not be stored yet (Drive is temporarily unavailable. Try again.)");
    expect(activationDocumentGate(FAILED).reason).toContain("Retry storing it before activating");
    expect(activationDocumentGate(NOT_CONFIGURED).reason).toContain("Drive storage not configured");
    expect(activationDocumentGate(NOT_CONFIGURED).reason).toContain("before activating");
  });

  it("STORED and NOT_APPLICABLE (a manual version, or a revision without a new signed file) are never blocked", () => {
    expect(activationDocumentGate(STORED)).toEqual({ blocked: false, reason: null });
    expect(activationDocumentGate(NOT_APPLICABLE)).toEqual({ blocked: false, reason: null });
    expect(activationDocumentGate(null)).toEqual({ blocked: false, reason: null });
    expect(activationDocumentGate(undefined)).toEqual({ blocked: false, reason: null });
  });
});

describe("Review & confirm: the state right after Confirm", () => {
  const base = { confirmed: true, storing: false, canManage: true };

  it("is nothing before the version is confirmed", () => {
    expect(reviewDocumentState({ ...base, confirmed: false, document: PENDING })).toBeNull();
    expect(reviewDocumentState({ ...base, document: null })).toBeNull();
  });

  it("shows 'Storing the original Agreement…' while the store call runs, with no button", () => {
    const state = reviewDocumentState({ ...base, document: PENDING, storing: true })!;
    expect(state).toMatchObject({ phase: "storing", text: STORING_TEXT, action: null });
    expect(STORING_TEXT).toBe("Storing the original Agreement…");
  });

  it("Stored is visible once the server says STORED", () => {
    const state = reviewDocumentState({ ...base, document: STORED })!;
    expect(state.phase).toBe("stored");
    expect(state.text).toContain("Stored");
    expect(state.action).toBeNull();
    expect(reviewDocumentState({ ...base, document: STORED_NO_LINK })!.note).toBe("Agreement document on file");
  });

  it("a failure keeps the reason visible and offers Retry (only to someone who may manage)", () => {
    const state = reviewDocumentState({ ...base, document: FAILED })!;
    expect(state.phase).toBe("failed");
    expect(state.note).toContain("Drive is temporarily unavailable. Try again.");
    expect(state.action?.label).toBe("Retry");
    expect(reviewDocumentState({ ...base, document: FAILED, canManage: false })!.action).toBeNull();
    expect(reviewDocumentState({ ...base, document: NOT_CONFIGURED })!.chip.label).toBe("Drive storage not configured");
  });

  it("a confirmed version whose store has not run yet offers `Store Agreement document`; a version without its own file says so", () => {
    expect(reviewDocumentState({ ...base, document: PENDING })).toMatchObject({ phase: "pending", action: { label: "Store Agreement document" } });
    expect(reviewDocumentState({ ...base, document: NOT_APPLICABLE })).toMatchObject({ phase: "not_applicable", text: "No new signed document for this version", action: null });
  });
});

describe("which versions get a row on the Overview", () => {
  const v = (version: number, confirmed: boolean, document: AgreementDocumentDto) => ({ version, confirmed, document });

  it("the viewed version; the current one is labelled as such", () => {
    const rows = documentPanelRows({ versions: [v(1, true, STORED)], head: { openVersion: null, activeVersion: 1 }, viewNumber: 1 });
    expect(rows).toEqual([{ version: 1, roleText: "Current version", document: STORED }]);
  });

  it("a confirmed replacement waiting for activation is listed FIRST even while the version in force is viewed (its document must be stored before activation)", () => {
    const rows = documentPanelRows({ versions: [v(2, true, PENDING), v(1, true, STORED)], head: { openVersion: 2, activeVersion: 1 }, viewNumber: 1 });
    expect(rows.map((row) => [row.version, row.roleText])).toEqual([
      [2, "Waiting for activation"],
      [1, "Current version"],
    ]);
  });

  it("an unconfirmed open draft is not a row of its own unless it is the viewed version; the same version is never listed twice", () => {
    expect(documentPanelRows({ versions: [v(2, false, NOT_APPLICABLE), v(1, true, STORED)], head: { openVersion: 2, activeVersion: 1 }, viewNumber: 1 }).map((row) => row.version)).toEqual([1]);
    expect(documentPanelRows({ versions: [v(2, true, PENDING), v(1, true, STORED)], head: { openVersion: 2, activeVersion: 1 }, viewNumber: 2 }).map((row) => [row.version, row.roleText])).toEqual([[2, "Open version"]]);
  });

  it("an earlier version being viewed says so, and its own document is shown (never the current one)", () => {
    const old = doc({ status: "STORED", fileName: "v1.pdf", storedAt: "2026-08-01T00:00:00.000Z", hasLink: true, link: "https://drive.invalid/fake/v1" });
    const rows = documentPanelRows({ versions: [v(2, true, STORED), v(1, true, old)], head: { openVersion: null, activeVersion: 2 }, viewNumber: 1 });
    expect(rows).toEqual([{ version: 1, roleText: "Viewing", document: old }]);
  });
});

describe("the Versions tab Document column", () => {
  it("maps each version's OWN document: link only when the server sent it, an honest note otherwise", () => {
    expect(versionDocumentCell(STORED)).toMatchObject({ chip: { label: "Stored" }, fileName: "Signed Agreement.pdf", link: LINK, note: null });
    expect(versionDocumentCell(STORED_NO_LINK)).toMatchObject({ link: null, note: "Agreement document on file" });
    expect(versionDocumentCell(PENDING)).toMatchObject({ chip: { label: "Not stored yet" }, link: null, fileName: null });
    expect(versionDocumentCell(FAILED)).toMatchObject({ chip: { label: "Storage failed" }, link: null });
    expect(versionDocumentCell(NOT_CONFIGURED).chip.label).toBe("Drive storage not configured");
    expect(versionDocumentCell(NOT_APPLICABLE)).toMatchObject({ chip: { label: "No new signed document" }, note: "No new signed document for this version", link: null, fileName: null });
  });
});

describe("Partner / Vendor contextual rows", () => {
  const entry = (over: Partial<CounterpartyAgreementDocumentDto> & { document: AgreementDocumentDto }): CounterpartyAgreementDocumentDto => ({
    agreementRef: "agr_1",
    version: 1,
    lifecycle: "ACTIVE",
    confirmed: true,
    headStatus: "ACTIVE",
    effectiveFrom: "2026-09-01",
    effectiveTo: null,
    ...over,
  });

  it("a stored document with a link: file name, Agreement version, stored date and the link", () => {
    const [row] = buildCounterpartyDocumentRows([entry({ document: STORED })]);
    expect(row).toMatchObject({ title: "Signed Agreement.pdf", link: LINK, onFileText: null, chip: null, note: null });
    expect(row!.metaText).toMatch(/^Agreement version 1 · Active · Stored \d{1,2} \w+ 2026/);
  });

  it("Step 14C: a confirmed version that is not active reads 'Activation pending', never a bare 'Draft'; an unconfirmed draft still reads 'Draft'", () => {
    const [awaiting] = buildCounterpartyDocumentRows([entry({ document: STORED, lifecycle: "DRAFT", headStatus: "DRAFT", confirmed: true })]);
    expect(awaiting!.metaText).toMatch(/^Agreement version 1 · Activation pending · Stored /);
    expect(awaiting!.metaText).not.toMatch(/Draft/);
    const [unconfirmed] = buildCounterpartyDocumentRows([entry({ document: PENDING, lifecycle: "DRAFT", headStatus: "DRAFT", confirmed: false })]);
    expect(unconfirmed!.metaText).toBe("Agreement version 1 · Draft");
    for (const [lifecycle, label] of [["ACTIVE", "Active"], ["SUSPENDED", "Suspended"], ["ENDED", "Ended"], ["SUPERSEDED", "Superseded"]] as const) {
      const [row] = buildCounterpartyDocumentRows([entry({ document: NOT_APPLICABLE, lifecycle, confirmed: true })]);
      expect(row!.metaText, lifecycle).toBe(`Agreement version 1 · ${label}`);
    }
  });

  it("without the link (finance access without contract access): the neutral 'Agreement document on file', never a link", () => {
    const [row] = buildCounterpartyDocumentRows([entry({ document: STORED_NO_LINK })]);
    expect(row).toMatchObject({ link: null, onFileText: "Agreement document on file" });
  });

  it("other states are honest: not stored / failed / not configured show their status text; no signed file of its own says so", () => {
    const rows = buildCounterpartyDocumentRows([
      entry({ version: 4, document: NOT_APPLICABLE, lifecycle: "DRAFT" }),
      entry({ version: 3, document: NOT_CONFIGURED, lifecycle: "DRAFT" }),
      entry({ version: 2, document: FAILED, lifecycle: "DRAFT" }),
      entry({ version: 1, document: PENDING, lifecycle: "DRAFT" }),
    ]);
    expect(rows.map((row) => row.chip?.label ?? row.note)).toEqual(["No new signed document for this version", "Drive storage not configured", "Storage failed", "Not stored yet"]);
    expect(rows.every((row) => row.link === null)).toBe(true);
    // the title is the neutral label when the server sent no file name
    expect(rows[0]!.title).toBe("Agreement document");
  });

  it("v1 and v2 keep their own files (distinct titles and links, never merged)", () => {
    const v1 = doc({ status: "STORED", fileName: "v1.pdf", storedAt: "2026-08-01T00:00:00.000Z", hasLink: true, link: "https://drive.invalid/fake/v1" });
    const v2 = doc({ status: "STORED", fileName: "v2.pdf", storedAt: "2026-09-01T00:00:00.000Z", hasLink: true, link: "https://drive.invalid/fake/v2" });
    const rows = buildCounterpartyDocumentRows([entry({ version: 2, document: v2 }), entry({ version: 1, lifecycle: "SUPERSEDED", document: v1 })]);
    expect(rows.map((row) => [row.title, row.link])).toEqual([
      ["v2.pdf", "https://drive.invalid/fake/v2"],
      ["v1.pdf", "https://drive.invalid/fake/v1"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
