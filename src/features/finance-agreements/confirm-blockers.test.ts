import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELD_KEYS } from "@/server/finance-agreements/fields";

import { blockerHeadline, describeConfirmBlocker, describeConfirmBlockers, fieldAnchorId, humanizeIssueText, sectionAnchorId } from "./confirm-blockers";

describe("describeConfirmBlocker - server codes -> plain language", () => {
  it("field_undecided: says what to do, names the field, jumps to it", () => {
    expect(describeConfirmBlocker({ code: "field_undecided", message: "Payment cycle must be decided.", fieldKey: "paymentCycle" })).toEqual({
      code: "field_undecided",
      fieldKey: "paymentCycle",
      message: "Payment cycle must be decided: use a value, or mark it Not applicable / Unavailable.",
      section: "commercial_terms",
      anchorId: "field-paymentCycle",
    });
  });
  it("field_pending", () => {
    expect(describeConfirmBlocker({ code: "field_pending", message: "Email address is awaiting a decision.", fieldKey: "emailAddress" })).toMatchObject({ message: "Email address has a proposed value that needs your decision.", section: "cross_verification", anchorId: "field-emailAddress" });
  });
  it("decision_without_value", () => {
    expect(describeConfirmBlocker({ code: "decision_without_value", message: "x", fieldKey: "currency" }).message).toBe("Currency was accepted without a value. Enter one, or mark it Unavailable.");
  });
  it("required_field_missing hides the internal path and the schema type error", () => {
    const view = describeConfirmBlocker({ code: "required_field_missing", message: "dates.effectiveFrom: Invalid input: expected string, received null", fieldKey: "effectiveDate" });
    expect(view.message).toBe("Effective date is required.");
    expect(view.message).not.toMatch(/dates\.|Invalid input|received/);
  });
  it("value_invalid keeps the useful part after the field label", () => {
    expect(describeConfirmBlocker({ code: "value_invalid", message: "PIN code: Expected a 6-digit PIN code.", fieldKey: "pinCode" }).message).toBe("PIN code: Expected a 6-digit PIN code.");
    expect(describeConfirmBlocker({ code: "value_invalid", message: "Payment cycle: Invalid option: expected one of \"WEEKLY\"", fieldKey: "paymentCycle" }).message).toBe("Payment cycle: Enter a valid value.");
  });
  it("field_not_applicable names the counterparty kind", () => {
    expect(describeConfirmBlocker({ code: "field_not_applicable", message: "x", fieldKey: "aadhaarNumber" }, "VENDOR").message).toBe("Aadhaar number does not apply to a Vendor Agreement.");
    expect(describeConfirmBlocker({ code: "field_not_applicable", message: "x", fieldKey: "aadhaarNumber" }, "PARTNER").message).toBe("Aadhaar number does not apply to a Partner Agreement.");
  });
  it("terms_invalid / contact_invalid strip the path and land in the right section", () => {
    expect(describeConfirmBlocker({ code: "terms_invalid", message: "commercial.currency: A currency is required when any amount is present.", fieldKey: "currency" })).toMatchObject({
      message: "Currency: A currency is required when any amount is present.",
      section: "commercial_terms",
      anchorId: "field-currency",
    });
    expect(describeConfirmBlocker({ code: "terms_invalid", message: "terms: Something is off." })).toMatchObject({ message: "Terms: Something is off.", section: "commercial_terms", anchorId: "section-commercial_terms" });
    expect(describeConfirmBlocker({ code: "contact_invalid", message: "pinCode: Expected a 6-digit PIN code." })).toMatchObject({ section: "cross_verification", anchorId: "section-cross_verification" });
  });
  it("an unknown code or an unknown field key degrades safely (no throw, no raw path)", () => {
    const view = describeConfirmBlocker({ code: "something_new", message: "commercial.qualifyingUnit: Needs a thing.", fieldKey: "notARealField" });
    expect(view).toEqual({ code: "something_new", fieldKey: null, message: "Needs a thing.", section: null, anchorId: "section-review" });
    expect(describeConfirmBlocker({ code: "x", message: "" }).message).toBe("Enter a valid value.");
  });
  it("every registry field key produces an anchor and a section", () => {
    for (const key of AGREEMENT_FIELD_KEYS) {
      const view = describeConfirmBlocker({ code: "field_undecided", message: "m", fieldKey: key });
      expect(view.fieldKey).toBe(key);
      expect(view.anchorId).toBe(fieldAnchorId(key));
      expect(view.section).not.toBeNull();
    }
  });
});

describe("describeConfirmBlockers", () => {
  it("keeps server order and drops exact duplicates", () => {
    const views = describeConfirmBlockers([
      { code: "field_undecided", message: "a", fieldKey: "paymentCycle" },
      { code: "field_pending", message: "b", fieldKey: "emailAddress" },
      { code: "field_undecided", message: "a again", fieldKey: "paymentCycle" },
    ]);
    expect(views.map((v) => v.anchorId)).toEqual(["field-paymentCycle", "field-emailAddress"]);
  });
  it("handles no blockers", () => {
    expect(describeConfirmBlockers(undefined)).toEqual([]);
    expect(describeConfirmBlockers([])).toEqual([]);
  });
});

describe("helpers", () => {
  it("humanizeIssueText strips a path prefix and hides raw schema errors", () => {
    expect(humanizeIssueText("dates.effectiveTo: The termination date cannot precede the effective date.")).toBe("The termination date cannot precede the effective date.");
    expect(humanizeIssueText("agreementType: agreementType must equal the type derived from the confirmed commercial structure.")).toBe("agreementType must equal the type derived from the confirmed commercial structure.");
    expect(humanizeIssueText("Invalid input: expected number, received string")).toBe("Enter a valid value.");
    expect(humanizeIssueText("plain sentence")).toBe("plain sentence");
  });
  it("anchors and the headline", () => {
    expect(sectionAnchorId("commercial_terms")).toBe("section-commercial_terms");
    expect(sectionAnchorId("review")).toBe("section-review");
    expect(blockerHeadline(0)).toBe("This Agreement is ready to confirm.");
    expect(blockerHeadline(1)).toBe("1 item needs attention before this Agreement can be confirmed.");
    expect(blockerHeadline(4)).toBe("4 items need attention before this Agreement can be confirmed.");
  });
});
