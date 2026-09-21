import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELDS, type AgreementFieldKey } from "@/server/finance-agreements/fields";

import { decisionActionsFor, decisionStateChip, keepValueLabel } from "./field-decision-logic";

const labels = (key: AgreementFieldKey, decision: Parameters<typeof decisionActionsFor>[0]["decision"] = null, origin: Parameters<typeof decisionActionsFor>[0]["origin"] = "EXTRACTED", hasValue = true) => decisionActionsFor({ fieldKey: key, decision, origin, hasValue }).map((a) => a.label);

describe("decisionActionsFor (mirrors the registry / checkFieldDecisionValue)", () => {
  it("offers the four affordances for an ordinary decided field with a proposal", () => {
    expect(labels("paymentCycle")).toEqual(["Use extracted", "Enter value", "Not applicable", "Unavailable"]);
  });
  it("omits 'Use ...' when there is no candidate value", () => {
    expect(labels("paymentCycle", null, null, false)).toEqual(["Enter value", "Not applicable", "Unavailable"]);
  });
  it("labels the keep action by origin", () => {
    expect(keepValueLabel("EXTRACTED")).toBe("Use extracted");
    expect(keepValueLabel("MASTER_DATA")).toBe("Use CreatorOps value");
    expect(keepValueLabel("MANUAL")).toBe("Keep value");
    expect(keepValueLabel(null)).toBe("Keep value");
    expect(labels("emailAddress", null, "MASTER_DATA")[0]).toBe("Use CreatorOps value");
  });
  it("never offers Not applicable / Unavailable for an always-required field", () => {
    expect(labels("counterpartyName", null, "MASTER_DATA")).toEqual(["Use CreatorOps value", "Enter value"]);
    expect(labels("effectiveDate")).toEqual(["Use extracted", "Enter value"]);
  });
  it("offers identity VALUE fields an acknowledgement only - never Enter value", () => {
    for (const key of ["panNumber", "aadhaarNumber", "gstin", "bankAccountNumber", "ifsc", "panHolderName"] as const) {
      const result = labels(key, null, null, false);
      expect(result).toEqual(["Acknowledge", "Not applicable", "Unavailable"]);
      expect(result).not.toContain("Enter value");
    }
  });
  it("offers computed fields nothing at all", () => {
    for (const key of ["agreementType", "partnerRef", "partnerAccountRefs", "aadhaarStatus", "panDocumentStatus", "gstCertificateStatus", "aadhaarDocumentStatus"] as const) expect(labels(key)).toEqual([]);
  });
  it("marks exactly the current decision as pressed", () => {
    const pressed = (decision: "ACCEPTED" | "CORRECTED" | "NOT_APPLICABLE" | "UNAVAILABLE" | "PENDING" | null) =>
      decisionActionsFor({ fieldKey: "paymentCycle", decision, origin: "EXTRACTED", hasValue: true })
        .filter((a) => a.pressed)
        .map((a) => a.label);
    expect(pressed("ACCEPTED")).toEqual(["Use extracted"]);
    expect(pressed("CORRECTED")).toEqual(["Enter value"]);
    expect(pressed("NOT_APPLICABLE")).toEqual(["Not applicable"]);
    expect(pressed("UNAVAILABLE")).toEqual(["Unavailable"]);
    expect(pressed("PENDING")).toEqual([]);
    expect(pressed(null)).toEqual([]);
  });
  it("only ever produces the four decision kinds the server accepts", () => {
    const allowed = new Set(["ACCEPTED", "CORRECTED", "NOT_APPLICABLE", "UNAVAILABLE"]);
    for (const field of AGREEMENT_FIELDS) for (const action of decisionActionsFor({ fieldKey: field.key, decision: null, origin: "MANUAL", hasValue: true })) expect(allowed.has(action.decision)).toBe(true);
  });
});

describe("decisionStateChip", () => {
  it("never implies acceptance: no entry needing a deliberate decision reads 'Needs decision'", () => {
    expect(decisionStateChip(null, { explicitDecisionRequired: true })).toEqual({ label: "Needs decision", tone: "orange" });
    expect(decisionStateChip(null, { explicitDecisionRequired: false })).toEqual({ label: "Not set", tone: "gray" });
    expect(decisionStateChip("PENDING", { explicitDecisionRequired: true }).label).toBe("Needs confirmation");
    expect(decisionStateChip("ACCEPTED", { explicitDecisionRequired: true }).label).toBe("Accepted");
    expect(decisionStateChip("CORRECTED", { explicitDecisionRequired: false }).label).toBe("Corrected");
  });
});
