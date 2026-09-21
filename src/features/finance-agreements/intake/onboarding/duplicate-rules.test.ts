import { describe, expect, it } from "vitest";

import { candidate, duplicatesDto } from "./onboarding-fixtures";
import {
  ACCOUNT_COLLISION_MESSAGE,
  candidateCards,
  decisionReadiness,
  describeSignal,
  effectiveDecision,
  NO_DECISION,
  NO_STRONG_MATCH_HEADING,
  NO_STRONG_MATCH_MESSAGE,
  OUTSIDE_ACCESS_MESSAGE,
  refusalNeedsRecheck,
  SUPPORTING_ONLY_HEADING,
  summarizeDuplicates,
  toDuplicateDecision,
} from "./duplicate-rules";

describe("summary of a duplicate check", () => {
  it("none: `No strong match found` + the limitation (never `No duplicate` / `No existing`), nothing to acknowledge", () => {
    const summary = summarizeDuplicates(duplicatesDto());
    expect(summary).toMatchObject({ kind: "none", heading: "No strong match found", requiresAcknowledgement: false, blocksCreateNew: false, blockMessage: null });
    expect(summary.message).toContain("Records stored with a different email or phone format may not be detected.");
    expect(`${summary.heading} ${summary.message}`).not.toMatch(/no duplicate|no existing|nothing in creatorops/i);
    for (const type of ["PARTNER", "VENDOR"] as const) {
      const each = summarizeDuplicates(duplicatesDto({ type }));
      expect(each.heading).toBe(NO_STRONG_MATCH_HEADING);
      expect(each.message).toBe(NO_STRONG_MATCH_MESSAGE);
    }
  });

  it("supporting-only: a name-only result is `Possible match (name only)`; other supporting evidence is worded as a hint; neither is called a strong or existing match", () => {
    const nameOnly = summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ strength: "SUPPORTING", signals: ["DISPLAY_NAME"] })] }));
    expect(nameOnly).toMatchObject({ kind: "possible", heading: "Possible match (name only)", hasStrong: false, requiresAcknowledgement: false, blocksCreateNew: false });
    expect(nameOnly.message).toMatch(/only a hint/);
    const phoneOnly = summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ strength: "SUPPORTING", signals: ["PHONE"] })] }));
    expect(phoneOnly).toMatchObject({ heading: SUPPORTING_ONLY_HEADING, hasStrong: false });
    // a strong candidate (or a strong match outside access) keeps the full warning
    expect(summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ strength: "SUPPORTING", signals: ["DISPLAY_NAME"] }), candidate({ ref: "b", strength: "STRONG", signals: ["EMAIL"] })] })).heading).toBe("Possible existing Partner found");
    expect(summarizeDuplicates(duplicatesDto({ status: "possible", strongMatchOutsideYourAccess: true })).heading).toBe("Possible existing Partner found");
  });

  it("possible: uses the exact heading, per type", () => {
    expect(summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate()] })).heading).toBe("Possible existing Partner found");
    expect(summarizeDuplicates(duplicatesDto({ type: "VENDOR", status: "possible", candidates: [candidate({ type: "VENDOR" })] })).heading).toBe("Possible existing Vendor found");
  });

  it("a STRONG candidate needs acknowledgement; a SUPPORTING-only result does not", () => {
    expect(summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ strength: "STRONG" })] })).requiresAcknowledgement).toBe(true);
    const supporting = summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ strength: "SUPPORTING", signals: ["DISPLAY_NAME"] })] }));
    expect(supporting).toMatchObject({ requiresAcknowledgement: false, hasStrong: false, blocksCreateNew: false });
  });

  it("unknown is never none: it needs acknowledgement and says the check could not be completed", () => {
    const summary = summarizeDuplicates(duplicatesDto({ status: "unknown" }));
    expect(summary).toMatchObject({ kind: "unknown", requiresAcknowledgement: true, heading: "The duplicate check could not be completed" });
    expect(summary.message).toMatch(/cannot be ruled out/);
    expect(summary.heading).not.toMatch(/No strong match|no duplicate|no existing/i);
  });

  it("a strong match outside access blocks creating with the neutral message and reveals nothing else", () => {
    const summary = summarizeDuplicates(duplicatesDto({ status: "possible", strongMatchOutsideYourAccess: true }));
    expect(summary).toMatchObject({ kind: "possible", outsideAccess: true, blocksCreateNew: true, candidateCount: 0 });
    expect(summary.blockMessage).toBe(OUTSIDE_ACCESS_MESSAGE("PARTNER"));
    expect(summary.blockMessage).toMatch(/outside your access/);
    expect(summary.message).toBe("A matching Partner exists, but not in your access.");
  });

  it("an Account that belongs to another Partner blocks creating (a strong duplicate signal)", () => {
    const summary = summarizeDuplicates(duplicatesDto({ status: "possible", candidates: [candidate({ signals: ["ACCOUNT_IDENTITY"] })] }));
    expect(summary).toMatchObject({ accountCollision: true, blocksCreateNew: true, blockMessage: ACCOUNT_COLLISION_MESSAGE });
  });
});

describe("candidate cards", () => {
  it("lists strong before supporting, then by name, with human signal text and no identity of anything else", () => {
    const cards = candidateCards(duplicatesDto({
      status: "possible",
      candidates: [candidate({ ref: "b", displayName: "Zed", strength: "SUPPORTING", signals: ["DISPLAY_NAME"] }), candidate({ ref: "a", displayName: "Yan", strength: "STRONG", signals: ["EMAIL", "PHONE"] }), candidate({ ref: "c", displayName: "Amy", strength: "SUPPORTING", signals: ["DISPLAY_NAME"], regions: [], status: "INACTIVE" })],
    }));
    expect(cards.map((card) => card.ref)).toEqual(["a", "c", "b"]);
    expect(cards[0]).toMatchObject({ strengthLabel: "Strong match", signals: ["Same email address", "Same phone number"], regionsText: "Karnataka", inactive: false });
    expect(cards[1]).toMatchObject({ regionsText: "No region recorded", inactive: true, strengthLabel: "Supporting match" });
    expect(describeSignal("ACCOUNT_IDENTITY")).toMatch(/Partner Account/);
  });
});

describe("decision readiness", () => {
  const strong = duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x" })] });
  const supporting = duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_s", strength: "SUPPORTING", signals: ["DISPLAY_NAME"] })] });

  it("`none` is decided without a click: create new, nothing to acknowledge", () => {
    const none = duplicatesDto();
    expect(effectiveDecision(summarizeDuplicates(none), NO_DECISION)).toEqual({ kind: "CREATE_NEW", acknowledged: false, reason: "" });
    expect(decisionReadiness(none, NO_DECISION)).toEqual({ ok: true });
    // a possible result waits for the person's own choice
    expect(effectiveDecision(summarizeDuplicates(strong), NO_DECISION)).toEqual(NO_DECISION);
    expect(decisionReadiness(strong, NO_DECISION)).toMatchObject({ ok: false });
  });

  it("use existing only for a record the check returned", () => {
    expect(decisionReadiness(strong, { kind: "USE_EXISTING", ref: "prt_x" })).toEqual({ ok: true });
    expect(decisionReadiness(strong, { kind: "USE_EXISTING", ref: "prt_other" })).toMatchObject({ ok: false });
  });

  it("continue creating despite a STRONG candidate needs the checkbox and a reason", () => {
    expect(decisionReadiness(strong, { kind: "CREATE_NEW", acknowledged: false, reason: "different person" })).toMatchObject({ ok: false, message: expect.stringMatching(/Confirm that you want to create/) });
    expect(decisionReadiness(strong, { kind: "CREATE_NEW", acknowledged: true, reason: "  " })).toMatchObject({ ok: false, message: expect.stringMatching(/short reason/) });
    expect(decisionReadiness(strong, { kind: "CREATE_NEW", acknowledged: true, reason: "ab" })).toMatchObject({ ok: false });
    expect(decisionReadiness(strong, { kind: "CREATE_NEW", acknowledged: true, reason: "Different person, same shared inbox" })).toEqual({ ok: true });
    expect(decisionReadiness(strong, { kind: "CREATE_NEW", acknowledged: true, reason: "x".repeat(1001) })).toMatchObject({ ok: false });
  });

  it("an unknown check needs the same acknowledgement", () => {
    const unknown = duplicatesDto({ status: "unknown" });
    expect(decisionReadiness(unknown, { kind: "CREATE_NEW", acknowledged: false, reason: "" })).toMatchObject({ ok: false, message: expect.stringMatching(/anyway/) });
    expect(decisionReadiness(unknown, { kind: "CREATE_NEW", acknowledged: true, reason: "Check service was down" })).toEqual({ ok: true });
  });

  it("supporting-only evidence: continuing needs the deliberate click but no acknowledgement", () => {
    expect(decisionReadiness(supporting, NO_DECISION)).toMatchObject({ ok: false });
    expect(decisionReadiness(supporting, { kind: "CREATE_NEW", acknowledged: false, reason: "" })).toEqual({ ok: true });
  });

  it("blocked results can never continue creating, acknowledged or not, but a visible record can still be used", () => {
    const outside = duplicatesDto({ status: "possible", strongMatchOutsideYourAccess: true, candidates: [candidate({ ref: "prt_v", strength: "SUPPORTING", signals: ["DISPLAY_NAME"] })] });
    expect(decisionReadiness(outside, { kind: "CREATE_NEW", acknowledged: true, reason: "I am sure about this" })).toMatchObject({ ok: false, message: expect.stringMatching(/outside your access/) });
    expect(decisionReadiness(outside, { kind: "USE_EXISTING", ref: "prt_v" })).toEqual({ ok: true });
    const collision = duplicatesDto({ status: "possible", candidates: [candidate({ signals: ["ACCOUNT_IDENTITY"] })] });
    expect(decisionReadiness(collision, { kind: "CREATE_NEW", acknowledged: true, reason: "I am sure about this" })).toMatchObject({ ok: false, message: ACCOUNT_COLLISION_MESSAGE });
  });

  it("builds the wire decision: USE_EXISTING with the ref; CREATE_NEW with the reason only when acknowledged", () => {
    expect(toDuplicateDecision({ kind: "USE_EXISTING", ref: "prt_x" })).toEqual({ kind: "USE_EXISTING", ref: "prt_x" });
    expect(toDuplicateDecision({ kind: "CREATE_NEW", acknowledged: true, reason: "  Different person " })).toEqual({ kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "Different person" });
    expect(toDuplicateDecision({ kind: "CREATE_NEW", acknowledged: false, reason: "left over text" })).toEqual({ kind: "CREATE_NEW", acknowledgedDuplicates: false });
    expect(toDuplicateDecision(NO_DECISION)).toBeNull();
  });

  it("a refusal about the duplicate rules means the earlier check no longer holds", () => {
    for (const code of ["strong_match_outside_access", "duplicate_acknowledgement_required", "duplicate_reason_required", "account_identity_collision", "use_existing_not_a_candidate"]) expect(refusalNeedsRecheck(code)).toBe(true);
    for (const code of ["counterparty_create_not_permitted", "account_management_not_permitted", null]) expect(refusalNeedsRecheck(code)).toBe(false);
  });
});
