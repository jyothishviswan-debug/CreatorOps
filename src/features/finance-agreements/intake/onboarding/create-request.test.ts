import { describe, expect, it } from "vitest";

import { buildOnboardingRequest, decisionFromRequest, formFromRequest, idForRequest, isValidClientRequestId, newOnboardingRequestId, requestSignature } from "./create-request";
import { NO_DECISION } from "./duplicate-rules";
import { emptyForm, type OnboardingForm } from "./wizard-form";

const form = (over: Partial<OnboardingForm> = {}): OnboardingForm => ({
  ...emptyForm("PARTNER", ["instagram", "youtube"]),
  displayName: "Asha Rao",
  email: "asha@example.com",
  regionId: "Karnataka",
  accounts: [
    { platform: "instagram", locatorKind: "LINK", locator: "https://www.instagram.com/asha", pageName: "Asha" },
    { platform: "youtube", locatorKind: "HANDLE", locator: "@ashatv", pageName: "" },
  ],
  ...over,
});
const CREATE = { kind: "CREATE_NEW", acknowledged: false, reason: "" } as const;

describe("build the create request", () => {
  it("IG + YT: ONE Partner (one reviewed profile) with one Account per platform", () => {
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form(), decision: CREATE })!;
    expect(request).toEqual({
      clientRequestId: "onboard-abc12345",
      type: "PARTNER",
      reviewedProfile: { displayName: "Asha Rao", email: "asha@example.com", regionIds: ["Karnataka"] },
      accounts: [
        { platform: "Instagram", profileUrl: "https://www.instagram.com/asha", displayName: "Asha" },
        { platform: "YouTube", handle: "@ashatv" },
      ],
      duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false },
    });
  });

  it("a Vendor request has a vendor type and no accounts", () => {
    const vendor = { ...emptyForm("VENDOR", []), displayName: "Acme Media", regionId: "Kerala", vendorType: "AGENCY" };
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "VENDOR", form: vendor, decision: CREATE })!;
    expect(request.reviewedProfile).toEqual({ displayName: "Acme Media", regionIds: ["Kerala"], vendorType: "AGENCY" });
    expect(request.accounts).toBeUndefined();
  });

  it("USE_EXISTING sends the candidate ref and the SAME probe (accounts included) the duplicate check used", () => {
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form(), decision: { kind: "USE_EXISTING", ref: "prt_x" } })!;
    expect(request.duplicateDecision).toEqual({ kind: "USE_EXISTING", ref: "prt_x" });
    expect(request.accounts).toHaveLength(2);
    expect(request.reviewedProfile.displayName).toBe("Asha Rao");
  });

  it("no decision, no request", () => {
    expect(buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form(), decision: NO_DECISION })).toBeNull();
  });

  it("carries no identity value (PAN / Aadhaar / GSTIN / bank) - the form has none to send", () => {
    const text = JSON.stringify(buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form(), decision: CREATE }));
    expect(text).not.toMatch(/pan|aadhaar|gst|ifsc|bank/i);
  });
});

describe("request identity", () => {
  it("the signature ignores the id and key order, and changes with any input", () => {
    const a = buildOnboardingRequest({ clientRequestId: "onboard-aaaaaaaa", type: "PARTNER", form: form(), decision: CREATE })!;
    const b = buildOnboardingRequest({ clientRequestId: "onboard-bbbbbbbb", type: "PARTNER", form: form(), decision: CREATE })!;
    expect(requestSignature(a)).toBe(requestSignature(b));
    const changed = buildOnboardingRequest({ clientRequestId: "onboard-aaaaaaaa", type: "PARTNER", form: form({ displayName: "Asha R" }), decision: CREATE })!;
    expect(requestSignature(changed)).not.toBe(requestSignature(a));
    const other = buildOnboardingRequest({ clientRequestId: "onboard-aaaaaaaa", type: "PARTNER", form: form(), decision: { kind: "USE_EXISTING", ref: "prt_x" } })!;
    expect(requestSignature(other)).not.toBe(requestSignature(a));
  });

  it("mints ids the server accepts", () => {
    expect(isValidClientRequestId(newOnboardingRequestId())).toBe(true);
    expect(isValidClientRequestId(newOnboardingRequestId(() => 0.5))).toBe(true);
    expect(isValidClientRequestId("short")).toBe(false);
  });

  it("reuses the id for the same body (a retry) and mints a new one only for a different body", () => {
    let minted = 0;
    const mint = () => `onboard-mint000${++minted}`;
    const first = idForRequest(null, "sig-1", mint);
    expect(first).toEqual({ id: "onboard-mint0001", signature: "sig-1" });
    expect(idForRequest(first, "sig-1", mint)).toBe(first);
    expect(idForRequest(first, "sig-1", mint).id).toBe("onboard-mint0001");
    const second = idForRequest(first, "sig-2", mint);
    expect(second.id).toBe("onboard-mint0002");
    expect(minted).toBe(2);
  });
});

describe("remembered request -> form (resume after a reload)", () => {
  it("rebuilds the same form and decision the request was built from", () => {
    const original = form({ legalName: "Asha Rao Pvt", phone: "+91 98765 43210" });
    const decision = { kind: "CREATE_NEW", acknowledged: true, reason: "Different person" } as const;
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: original, decision })!;
    expect(formFromRequest(request, ["instagram", "youtube"])).toEqual(original);
    expect(decisionFromRequest(request)).toEqual(decision);
    // and it round-trips back to the SAME body, so a retry after a reload sends exactly what the ledger holds
    const again = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: formFromRequest(request, ["instagram", "youtube"]), decision: decisionFromRequest(request) })!;
    expect(requestSignature(again)).toBe(requestSignature(request));
  });

  it("rebuilds a USE_EXISTING request and a Vendor request", () => {
    const use = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form(), decision: { kind: "USE_EXISTING", ref: "prt_x" } })!;
    expect(decisionFromRequest(use)).toEqual({ kind: "USE_EXISTING", ref: "prt_x" });
    const vendorForm = { ...emptyForm("VENDOR", []), displayName: "Acme", regionId: "Kerala", vendorType: "AGENCY" };
    const vendor = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "VENDOR", form: vendorForm, decision: CREATE })!;
    expect(formFromRequest(vendor, [])).toEqual(vendorForm);
  });

  it("leaves a row blank when the remembered request has no account for that platform", () => {
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: form({ accounts: [form().accounts[0]!] }), decision: CREATE })!;
    const restored = formFromRequest(request, ["instagram", "youtube"]);
    expect(restored.accounts[0]!.locator).toBe("https://www.instagram.com/asha");
    expect(restored.accounts[1]).toEqual({ platform: "youtube", locatorKind: "LINK", locator: "", pageName: "" });
  });
});
