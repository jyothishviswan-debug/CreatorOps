import { describe, expect, it, vi } from "vitest";

import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import type { PartnerDoc } from "@/server/partners/types";
import type { VendorDoc } from "@/server/vendors/types";

import {
  buildDuplicatesDto,
  evaluateOnboardingDuplicates,
  groupEvidence,
  normalizeOnboardingEmail,
  normalizeOnboardingName,
  normalizeOnboardingPhone,
  onboardingDuplicatesInputSchema,
  strengthOf,
  type OnboardingDuplicateDeps,
  type ResolvedDuplicateRecord,
} from "./onboarding-duplicates";

// Pure + stub-driven tests of the duplicate wrapper: normalization, strength rules, the live-scope filter and the leak guarantees. The
// emulator suite (onboarding.emulator.test.ts) runs the same wrapper against the real owning duplicate checks.

const ACTOR = { uid: "actor-1", userRef: "usr-actor-1", role: "x", email: "a@b.co", displayName: "A" } as unknown as ActorContext;
const NOW = "2026-09-01T00:00:00.000Z";
const REGION_GRANT: ScopeGrant = { type: "REGION", region: "Kerala" } as ScopeGrant;

const partnerDoc = (over: Partial<PartnerDoc>): PartnerDoc => ({ uid: "p-uid", partnerRef: "p-ref", displayName: "Asha Studio", regionIds: ["Kerala"], teamIds: [], ownerUid: null, status: "ACTIVE", ...over }) as PartnerDoc;
const vendorDoc = (over: Partial<VendorDoc>): VendorDoc => ({ uid: "v-uid", vendorRef: "v-ref", displayName: "Acme Media", regionIds: ["Kerala"], teamIds: [], ownerUid: null, status: "ACTIVE", ...over }) as VendorDoc;

type Stub = {
  partnerMatches?: Array<{ type: "email" | "phone" | "accountIdentity" | "originLeadRef"; ref: string; confidence: "high" | "medium" | "low" }>;
  partnerStatus?: "unknown" | "none" | "possible" | "confirmed";
  accountMatches?: Array<{ type: "accountIdentity"; ref: string; confidence: "high" }>;
  vendorMatches?: Array<{ type: "email" | "phone" | "displayName"; ref: string; confidence: "high" | "medium" | "low" }>;
  named?: PartnerDoc[];
  partners?: PartnerDoc[];
  vendors?: VendorDoc[];
  grants?: ScopeGrant[];
  failName?: boolean;
  failLoad?: boolean;
};

function deps(stub: Stub): OnboardingDuplicateDeps & { spies: { checkPartners: ReturnType<typeof vi.fn>; checkVendors: ReturnType<typeof vi.fn> } } {
  const checkPartners = vi.fn(async (input: { email?: string; phone?: string; accountIdentity?: unknown }) => {
    const isAccount = input.accountIdentity !== undefined;
    return { status: stub.partnerStatus ?? "possible", matches: isAccount ? (stub.accountMatches ?? []) : (stub.partnerMatches ?? []), checkedAt: NOW };
  });
  const checkVendors = vi.fn(async () => ({ status: stub.partnerStatus ?? "possible", matches: stub.vendorMatches ?? [], checkedAt: NOW }));
  return {
    checkPartners: checkPartners as unknown as OnboardingDuplicateDeps["checkPartners"],
    checkVendors: checkVendors as unknown as OnboardingDuplicateDeps["checkVendors"],
    findPartnersByName: (async () => {
      if (stub.failName) throw new Error("boom");
      return stub.named ?? [];
    }) as OnboardingDuplicateDeps["findPartnersByName"],
    loadPartners: (async (refs: string[]) => {
      if (stub.failLoad) throw new Error("boom");
      return new Map((stub.partners ?? []).filter((doc) => refs.includes(doc.partnerRef)).map((doc) => [doc.partnerRef, doc] as const));
    }) as OnboardingDuplicateDeps["loadPartners"],
    loadVendors: (async (refs: string[]) => new Map((stub.vendors ?? []).filter((doc) => refs.includes(doc.vendorRef)).map((doc) => [doc.vendorRef, doc] as const))) as OnboardingDuplicateDeps["loadVendors"],
    loadGrants: async () => stub.grants ?? [REGION_GRANT],
    spies: { checkPartners, checkVendors },
  };
}

describe("owning normalizers (never the reconciliation normalizer)", () => {
  it("email is lower-trimmed; phone keeps only digits and +; a name is lower-trimmed", () => {
    expect(normalizeOnboardingEmail("PARTNER", "  Hello@Example.COM ")).toBe("hello@example.com");
    expect(normalizeOnboardingEmail("VENDOR", "  Hello@Example.COM ")).toBe("hello@example.com");
    expect(normalizeOnboardingPhone("PARTNER", "+91 (98765) 43-210")).toBe("+919876543210");
    expect(normalizeOnboardingPhone("VENDOR", "98765 43210")).toBe("9876543210");
    expect(normalizeOnboardingName("PARTNER", "  Asha STUDIO ")).toBe("asha studio");
    expect(normalizeOnboardingName("VENDOR", "  Asha STUDIO ")).toBe("asha studio");
    expect(normalizeOnboardingEmail("PARTNER", undefined)).toBeUndefined();
    expect(normalizeOnboardingPhone("PARTNER", "abc")).toBeUndefined();
  });
});

describe("strength rules", () => {
  it("an email or an Account identity match is STRONG; a phone match together with an exact name match is STRONG", () => {
    expect(strengthOf(["EMAIL"])).toBe("STRONG");
    expect(strengthOf(["ACCOUNT_IDENTITY"])).toBe("STRONG");
    expect(strengthOf(["PHONE", "DISPLAY_NAME"])).toBe("STRONG");
  });

  it("a name alone is NEVER strong; a phone alone is only supporting", () => {
    expect(strengthOf(["DISPLAY_NAME"])).toBe("SUPPORTING");
    expect(strengthOf(["PHONE"])).toBe("SUPPORTING");
  });

  it("groups evidence per record, de-duplicated and in a stable order", () => {
    const grouped = groupEvidence([
      { ref: "a", signal: "DISPLAY_NAME" },
      { ref: "a", signal: "EMAIL" },
      { ref: "a", signal: "EMAIL" },
      { ref: "b", signal: "PHONE" },
    ]);
    expect(grouped.get("a")).toEqual(["EMAIL", "DISPLAY_NAME"]);
    expect(grouped.get("b")).toEqual(["PHONE"]);
  });
});

describe("input", () => {
  it("is strict, trims, and rejects accounts for a Vendor", () => {
    expect(onboardingDuplicatesInputSchema.safeParse({ type: "PARTNER", displayName: "  Asha  " })).toMatchObject({ success: true, data: { displayName: "Asha" } });
    expect(onboardingDuplicatesInputSchema.safeParse({ type: "PARTNER", displayName: "Asha", scope: "GLOBAL" }).success).toBe(false);
    expect(onboardingDuplicatesInputSchema.safeParse({ type: "VENDOR", displayName: "Acme", accounts: [{ platform: "Instagram", handle: "x" }] }).success).toBe(false);
    expect(onboardingDuplicatesInputSchema.safeParse({ type: "PARTNER", displayName: "" }).success).toBe(false);
  });
});

describe("evaluateOnboardingDuplicates: Partner", () => {
  const input = onboardingDuplicatesInputSchema.parse({ type: "PARTNER", displayName: "Asha Studio", email: "ASHA@Example.com", phone: "+91 98765 43210", accounts: [{ platform: "Instagram", handle: "asha", profileUrl: "https://instagram.com/asha" }] });

  it("normalizes with the owning normalizers before calling the owning check, and probes each account locator on its own", async () => {
    const d = deps({});
    await evaluateOnboardingDuplicates(ACTOR, input, d);
    expect(d.spies.checkPartners).toHaveBeenNthCalledWith(1, { email: "asha@example.com", phone: "+919876543210" });
    expect(d.spies.checkPartners).toHaveBeenNthCalledWith(2, { accountIdentity: { platform: "Instagram", profileUrl: "https://instagram.com/asha" } });
    expect(d.spies.checkPartners).toHaveBeenNthCalledWith(3, { accountIdentity: { platform: "Instagram", handle: "asha" } });
  });

  it("no evidence anywhere -> status none", async () => {
    expect(await evaluateOnboardingDuplicates(ACTOR, input, deps({}))).toMatchObject({ status: "none", candidates: [], strongMatchOutsideYourAccess: false });
  });

  it("an in-scope email match is a STRONG candidate with display data only", async () => {
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "email", ref: "p-ref", confidence: "high" }], partners: [partnerDoc({})] }));
    expect(dto.status).toBe("possible");
    expect(dto.candidates).toEqual([{ type: "PARTNER", ref: "p-ref", displayName: "Asha Studio", regions: ["Kerala"], status: "ACTIVE", signals: ["EMAIL"], strength: "STRONG" }]);
    expect(dto.strongMatchOutsideYourAccess).toBe(false);
  });

  it("an exact name match is SUPPORTING evidence only, and combines with a phone match to STRONG", async () => {
    const named = await evaluateOnboardingDuplicates(ACTOR, input, deps({ named: [partnerDoc({})], partners: [partnerDoc({})] }));
    expect(named.candidates).toMatchObject([{ signals: ["DISPLAY_NAME"], strength: "SUPPORTING" }]);
    const both = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "phone", ref: "p-ref", confidence: "medium" }], named: [partnerDoc({})], partners: [partnerDoc({})] }));
    expect(both.candidates).toMatchObject([{ signals: ["PHONE", "DISPLAY_NAME"], strength: "STRONG" }]);
  });

  it("an Account identity match is STRONG", async () => {
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ accountMatches: [{ type: "accountIdentity", ref: "p-ref", confidence: "high" }], partners: [partnerDoc({})] }));
    expect(dto.candidates).toMatchObject([{ signals: ["ACCOUNT_IDENTITY"], strength: "STRONG" }]);
  });

  it("an OUT-OF-SCOPE strong match is only the neutral flag: no ref, name, region, count or signal anywhere in the DTO", async () => {
    const hidden = partnerDoc({ partnerRef: "p-secret-ref", displayName: "Secret Talent Agency", regionIds: ["Assam"] });
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "email", ref: "p-secret-ref", confidence: "high" }], partners: [hidden] }));
    expect(dto.strongMatchOutsideYourAccess).toBe(true);
    expect(dto.candidates).toEqual([]);
    expect(dto.status).toBe("possible");
    const text = JSON.stringify(dto);
    for (const leaked of ["p-secret-ref", "Secret Talent Agency", "Assam", "EMAIL"]) expect(text).not.toContain(leaked);
  });

  it("an OUT-OF-SCOPE supporting-only match leaves no trace at all", async () => {
    const hidden = partnerDoc({ partnerRef: "p-secret-ref", displayName: "Asha Studio", regionIds: ["Assam"] });
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ named: [hidden], partners: [hidden] }));
    expect(dto).toMatchObject({ status: "none", candidates: [], strongMatchOutsideYourAccess: false });
    expect(JSON.stringify(dto)).not.toContain("p-secret-ref");
  });

  it("a visible candidate and a hidden strong match together: the candidate is listed, the hidden one is only the flag", async () => {
    const hidden = partnerDoc({ uid: "hid", partnerRef: "p-hidden", displayName: "Hidden Co", regionIds: ["Assam"] });
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "email", ref: "p-hidden", confidence: "high" }, { type: "phone", ref: "p-ref", confidence: "medium" }], partners: [hidden, partnerDoc({})] }));
    expect(dto.candidates.map((candidate) => candidate.ref)).toEqual(["p-ref"]);
    expect(dto.strongMatchOutsideYourAccess).toBe(true);
    expect(JSON.stringify(dto)).not.toContain("Hidden Co");
  });

  it("a match whose record cannot be loaded is treated as outside the actor's access (fail closed)", async () => {
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "email", ref: "p-ghost", confidence: "high" }], partners: [] }));
    expect(dto.strongMatchOutsideYourAccess).toBe(true);
    expect(dto.candidates).toEqual([]);
  });

  it("if the records cannot be loaded to verify scope, nothing is exposed", async () => {
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: [{ type: "email", ref: "p-ref", confidence: "high" }], partners: [partnerDoc({})], failLoad: true }));
    expect(dto.candidates).toEqual([]);
    expect(dto.strongMatchOutsideYourAccess).toBe(true);
  });

  it("a lookup that could not run is `unknown`, never `none`", async () => {
    expect(await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerStatus: "unknown" }))).toMatchObject({ status: "unknown", candidates: [] });
    expect(await evaluateOnboardingDuplicates(ACTOR, input, deps({ failName: true }))).toMatchObject({ status: "unknown" });
  });

  it("sorts STRONG first, then by name, and is bounded", async () => {
    const docs = Array.from({ length: 14 }, (_, index) => partnerDoc({ uid: `u${index}`, partnerRef: `r${index}`, displayName: `Name ${String(index).padStart(2, "0")}` }));
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ partnerMatches: docs.map((doc, index) => ({ type: index === 13 ? ("email" as const) : ("phone" as const), ref: doc.partnerRef, confidence: "medium" as const })), partners: docs }));
    expect(dto.candidates).toHaveLength(10);
    expect(dto.candidates[0]).toMatchObject({ ref: "r13", strength: "STRONG" });
  });
});

describe("evaluateOnboardingDuplicates: Vendor", () => {
  const input = onboardingDuplicatesInputSchema.parse({ type: "VENDOR", displayName: "Acme Media", email: "Hello@Acme.com", phone: "98765 43210" });

  it("uses the owning Vendor check (normalized) and maps its signals; its name signal is supporting", async () => {
    const d = deps({ vendorMatches: [{ type: "displayName", ref: "v-ref", confidence: "low" }], vendors: [vendorDoc({})] });
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, d);
    expect(d.spies.checkVendors).toHaveBeenCalledWith({ displayName: "Acme Media", email: "hello@acme.com", phone: "9876543210" });
    expect(d.spies.checkPartners).not.toHaveBeenCalled();
    expect(dto.candidates).toMatchObject([{ type: "VENDOR", ref: "v-ref", signals: ["DISPLAY_NAME"], strength: "SUPPORTING" }]);
  });

  it("an out-of-scope strong Vendor match is only the flag", async () => {
    const hidden = vendorDoc({ vendorRef: "v-secret", displayName: "Hidden Vendor", regionIds: ["Assam"] });
    const dto = await evaluateOnboardingDuplicates(ACTOR, input, deps({ vendorMatches: [{ type: "email", ref: "v-secret", confidence: "high" }], vendors: [hidden] }));
    expect(dto).toMatchObject({ strongMatchOutsideYourAccess: true, candidates: [] });
    expect(JSON.stringify(dto)).not.toMatch(/v-secret|Hidden Vendor|Assam/);
  });
});

describe("buildDuplicatesDto", () => {
  it("carries no identity value and no key beyond the documented ones", () => {
    const resolved = new Map<string, ResolvedDuplicateRecord>([["p1", { visible: true, displayName: "Asha", regions: ["Kerala"], status: "ACTIVE" }]]);
    const dto = buildDuplicatesDto({ type: "PARTNER", evidence: [{ ref: "p1", signal: "EMAIL" }], lookupUnknown: false, resolved, checkedAt: NOW });
    expect(Object.keys(dto).sort()).toEqual(["candidates", "checkedAt", "status", "strongMatchOutsideYourAccess", "type"]);
    expect(Object.keys(dto.candidates[0]!).sort()).toEqual(["displayName", "ref", "regions", "signals", "status", "strength", "type"]);
  });
});
