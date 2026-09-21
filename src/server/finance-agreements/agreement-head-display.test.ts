import { describe, expect, it } from "vitest";

import { partnerDocSchema } from "@/server/partners/types";

import { applyFieldDecision, buildMasterDataDraft } from "./agreement-draft";
import { buildHeadDisplay, countUnresolvedDraftFields, governingVersionNumber, withHeadDisplay } from "./agreement-head-display";
import { assembleConfirmedAgreement, type AgreementFieldKey } from "./fields";
import type { AuthorizedCounterparty } from "./finance-agreements-gate";
import { READY_DECISIONS } from "./testing/agreement-service-fixtures";
import { agreementHeadDisplaySchema, agreementHeadDocSchema, agreementVersionDocSchema, type AgreementDraft, type AgreementHeadDoc, type AgreementVersionDoc } from "./types";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-02T10:00:00.000Z";
const ACTOR = "user-ref-1";

function authorized(): AuthorizedCounterparty {
  const p = partnerDocSchema.parse({ uid: "p-uid", partnerRef: "p-ref", version: 1, displayName: "Display Partner", displayNameLower: "display partner", email: "a@example.test", phone: "+91 90000 00000", status: "ACTIVE", regionIds: ["Kerala"], createdAt: NOW, createdByUserRef: "x", updatedAt: NOW, updatedByUserRef: "x" });
  return { type: "PARTNER", counterparty: { type: "PARTNER", partnerRef: "p-ref", partnerAccountRefs: [], platformScope: [] }, scope: { ownerUid: null, regionIds: ["Kerala"], teamIds: [], partnerUid: "p-uid", vendorUid: null }, displayName: p.displayName, partner: p, accounts: [] };
}

const COUNTERPARTY = { type: "PARTNER", partnerRef: "p-ref", partnerAccountRefs: [], platformScope: [] } as const;

function draftVersion(version: number, draft: AgreementDraft, over: Partial<AgreementVersionDoc> = {}): AgreementVersionDoc {
  return agreementVersionDocSchema.parse({
    agreementRef: "agr_0123456789abcdef0123",
    version,
    status: "DRAFT",
    docVersion: 1,
    counterparty: COUNTERPARTY,
    sourceMode: "MANUAL",
    source: { contractArtifactRef: null, extractionRunRef: null, parserVersion: null },
    draft,
    createdAt: NOW,
    createdByUserRef: ACTOR,
    updatedAt: NOW,
    updatedByUserRef: ACTOR,
    ...over,
  });
}

function decided(draft: AgreementDraft, key: AgreementFieldKey, decision: "ACCEPTED" | "CORRECTED", value?: unknown): AgreementDraft {
  const result = applyFieldDecision({ existing: draft[key], fieldKey: key, decision, value, actorUserRef: ACTOR, now: NOW });
  if (!result.ok) throw new Error(result.message);
  return { ...draft, [key]: result.entry };
}

function confirmedVersion(version: number, status: "DRAFT" | "ACTIVE" | "ENDED" = "DRAFT"): AgreementVersionDoc {
  let draft = buildMasterDataDraft(authorized());
  for (const seed of READY_DECISIONS) {
    const result = applyFieldDecision({ existing: draft[seed.fieldKey], fieldKey: seed.fieldKey, decision: seed.decision, value: seed.value, actorUserRef: ACTOR, now: NOW });
    if (!result.ok) throw new Error(result.message);
    draft = { ...draft, [seed.fieldKey]: result.entry };
  }
  for (const key of ["contactNumber", "emailAddress", "state"] as AgreementFieldKey[]) draft = decided(draft, key, "ACCEPTED");
  const assembled = assembleConfirmedAgreement({ draft, counterpartyType: "PARTNER", actorUserRef: ACTOR, confirmedAt: NOW });
  if (!assembled.ok) throw new Error(JSON.stringify(assembled.blockers));
  const lifecycle = status === "DRAFT" ? {} : { status, activation: { activatedByUserRef: ACTOR, activatedAt: NOW, supersededVersion: null }, ...(status === "ENDED" ? { endedAt: LATER, endedByUserRef: ACTOR, endReason: "done" } : {}) };
  return draftVersion(version, {}, {
    sourceMode: assembled.sourceMode,
    terms: assembled.terms,
    contactSnapshot: assembled.contactSnapshot,
    identityStatusSnapshot: { state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "MISSING", bank: "MISSING" }, capturedAt: NOW },
    fieldProvenance: assembled.fieldProvenance,
    effective: assembled.effective,
    confirmation: { confirmedByUserRef: ACTOR, confirmedAt: NOW },
    ...lifecycle,
  } as Partial<AgreementVersionDoc>);
}

function head(over: Record<string, unknown> = {}): AgreementHeadDoc {
  return agreementHeadDocSchema.parse({
    agreementRef: "agr_0123456789abcdef0123",
    docVersion: 4,
    counterparty: COUNTERPARTY,
    partnerUid: "p-uid",
    regionIds: ["Kerala"],
    status: "DRAFT",
    latestVersion: 1,
    openVersion: 1,
    createdAt: NOW,
    createdByUserRef: ACTOR,
    updatedAt: NOW,
    updatedByUserRef: ACTOR,
    ...over,
  });
}

describe("governingVersionNumber", () => {
  it("is the active/suspended version, else the ended one, else null (a never-activated agreement has none)", () => {
    expect(governingVersionNumber({ status: "DRAFT", openVersion: 1, activeVersion: null, lastEndedVersion: null })).toBeNull();
    expect(governingVersionNumber({ status: "ACTIVE", openVersion: 2, activeVersion: 1, lastEndedVersion: null })).toBe(1);
    expect(governingVersionNumber({ status: "SUSPENDED", openVersion: null, activeVersion: 3, lastEndedVersion: 2 })).toBe(3);
    expect(governingVersionNumber({ status: "ENDED", openVersion: null, activeVersion: null, lastEndedVersion: 2 })).toBe(2);
  });
});

describe("countUnresolvedDraftFields", () => {
  it("counts PENDING entries only, and is 0 for no version or a confirmed one", () => {
    const pending = buildMasterDataDraft(authorized());
    const pendingCount = Object.keys(pending).length;
    expect(pendingCount).toBeGreaterThan(0);
    expect(countUnresolvedDraftFields(draftVersion(1, pending))).toBe(pendingCount);
    expect(countUnresolvedDraftFields(draftVersion(1, decided(pending, "counterpartyName", "ACCEPTED")))).toBe(pendingCount - 1);
    expect(countUnresolvedDraftFields(null)).toBe(0);
    expect(countUnresolvedDraftFields(confirmedVersion(1))).toBe(0);
  });
});

describe("buildHeadDisplay", () => {
  it("a first unconfirmed draft: dates / number from the draft entries, no type yet, unresolved = PENDING entries, name lower-cased", () => {
    let draft = buildMasterDataDraft(authorized());
    draft = decided(draft, "effectiveDate", "CORRECTED", "2025-04-01");
    draft = decided(draft, "terminationDate", "CORRECTED", "2026-03-31");
    draft = decided(draft, "agreementNumber", "CORRECTED", "  AG-77 ");
    const open = draftVersion(1, draft);
    const display = buildHeadDisplay({ head: head(), counterpartyName: "Display Partner", open, governing: null, extractionStatus: "PARTIAL", projectedAt: LATER });
    expect(agreementHeadDisplaySchema.safeParse(display).success).toBe(true);
    expect(display).toMatchObject({
      counterpartyName: "Display Partner",
      counterpartyNameLower: "display partner",
      agreementNumber: "AG-77",
      agreementType: null,
      effectiveFrom: "2025-04-01",
      effectiveTo: "2026-03-31",
      sourceMode: "MANUAL",
      openVersionConfirmed: false,
      extractionStatus: "PARTIAL",
      governingStatus: "DRAFT",
      projectedAt: LATER,
    });
    expect(display.unresolvedFieldCount).toBe(countUnresolvedDraftFields(open));
  });

  it("garbage in a draft date / number never reaches the projection", () => {
    let draft = buildMasterDataDraft(authorized());
    draft = decided(draft, "effectiveDate", "CORRECTED", "2025-04-01");
    const open = draftVersion(1, { ...draft, effectiveDate: { ...draft.effectiveDate!, value: "not-a-date" }, agreementNumber: { ...draft.effectiveDate!, value: 42 } });
    const display = buildHeadDisplay({ head: head(), counterpartyName: "N", open, governing: null, extractionStatus: null, projectedAt: LATER });
    expect(display).toMatchObject({ effectiveFrom: null, agreementNumber: null });
  });

  it("a confirmed open version awaiting activation: from frozen terms, unresolved 0, openVersionConfirmed true", () => {
    const open = confirmedVersion(1);
    const display = buildHeadDisplay({ head: head(), counterpartyName: "N", open, governing: null, extractionStatus: null, projectedAt: LATER });
    expect(display).toMatchObject({ effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", agreementType: "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT", unresolvedFieldCount: 0, openVersionConfirmed: true });
  });

  it("an ACTIVE agreement with an open revision: dates/type describe the GOVERNING version, unresolved/confirmed describe the OPEN one", () => {
    const governing = confirmedVersion(1, "ACTIVE");
    const revision = draftVersion(2, decided(buildMasterDataDraft(authorized()), "counterpartyName", "ACCEPTED"));
    const display = buildHeadDisplay({ head: head({ status: "ACTIVE", activeVersion: 1, openVersion: 2, latestVersion: 2 }), counterpartyName: "N", open: revision, governing, extractionStatus: null, projectedAt: LATER });
    expect(display).toMatchObject({ effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", governingStatus: "ACTIVE", openVersionConfirmed: false });
    expect(display.unresolvedFieldCount).toBe(countUnresolvedDraftFields(revision));
  });

  it("an ENDED agreement is described by the ended version; no open version means 0 unresolved", () => {
    const ended = confirmedVersion(1, "ENDED");
    const display = buildHeadDisplay({ head: head({ status: "ENDED", openVersion: null, lastEndedVersion: 1 }), counterpartyName: "N", open: null, governing: ended, extractionStatus: "EXTRACTED", projectedAt: LATER });
    expect(display).toMatchObject({ governingStatus: "ENDED", unresolvedFieldCount: 0, openVersionConfirmed: false, effectiveFrom: "2024-01-01", extractionStatus: "EXTRACTED" });
  });

  it("an empty name falls back to a neutral label and a long one is bounded", () => {
    expect(buildHeadDisplay({ head: head(), counterpartyName: "   ", open: null, governing: null, extractionStatus: null, projectedAt: LATER }).counterpartyName).toBe("Unknown");
    expect(buildHeadDisplay({ head: head(), counterpartyName: "X".repeat(500), open: null, governing: null, extractionStatus: null, projectedAt: LATER }).counterpartyName).toHaveLength(200);
  });
});

describe("withHeadDisplay", () => {
  const open = draftVersion(1, buildMasterDataDraft(authorized()));

  it("refreshes ONLY display: docVersion, lifecycle pointers and updatedAt are untouched (a client's head docVersion stays valid)", () => {
    const before = head();
    const after = withHeadDisplay(before, { counterpartyName: "Display Partner", open, governing: null, projectedAt: LATER });
    expect(after.docVersion).toBe(before.docVersion);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect({ ...after, display: null }).toEqual({ ...before, display: null });
    expect(after.display?.projectedAt).toBe(LATER);
  });

  it("carries the previous extractionStatus unless one is passed explicitly (null resets it)", () => {
    const seeded = withHeadDisplay(head(), { counterpartyName: "N", open, governing: null, projectedAt: LATER, extractionStatus: "EXTRACTED" });
    expect(seeded.display?.extractionStatus).toBe("EXTRACTED");
    expect(withHeadDisplay(seeded, { counterpartyName: "N", open, governing: null, projectedAt: LATER }).display?.extractionStatus).toBe("EXTRACTED");
    expect(withHeadDisplay(seeded, { counterpartyName: "N", open, governing: null, projectedAt: LATER, extractionStatus: null }).display?.extractionStatus).toBeNull();
  });

  it("touchedBy stamps updatedAt / updatedByUserRef (draft-editing commands) but still never docVersion", () => {
    const before = head();
    const after = withHeadDisplay(before, { counterpartyName: "N", open, governing: null, projectedAt: LATER, touchedBy: { actorUserRef: "someone" } });
    expect(after).toMatchObject({ docVersion: before.docVersion, updatedAt: LATER, updatedByUserRef: "someone", status: before.status, openVersion: before.openVersion });
  });

  it("a head with display null (written before Step 14B) parses and stays valid", () => {
    expect(head().display).toBeNull();
  });
});
