import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";

import { isVendorDocInScope } from "./vendors-gate";

// Step 14A: the pure Vendor Record Scope decision (requireVendorInScope
// delegates to it), exercised with in-memory grants - no Firestore. Mirrors
// partners-gate.test.ts. Deliberately there is NO PARTNER grant path: a visible
// Partner relationship never bridges into a Vendor's scope (Step 8A section 7).
const base = { uid: "actor-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "system:test" };
const vendor = { uid: "vendor-uid-1", ownerUid: "owner-1" as string | null, regionIds: ["Kerala"], teamIds: ["team-a"] };

describe("isVendorDocInScope", () => {
  it("a GLOBAL grant sees every Vendor", () => {
    expect(isVendorDocInScope([{ type: "GLOBAL", ...base } as ScopeGrant], "actor-1", vendor)).toBe(true);
  });
  it("SELF grant: only the Vendor's owner", () => {
    const self = [{ type: "SELF", ...base } as ScopeGrant];
    expect(isVendorDocInScope(self, "owner-1", vendor)).toBe(true);
    expect(isVendorDocInScope(self, "someone-else", vendor)).toBe(false);
    expect(isVendorDocInScope(self, "owner-1", { ...vendor, ownerUid: null })).toBe(false);
  });
  it("REGION and TEAM grants match the Vendor's own dimensions", () => {
    expect(isVendorDocInScope([{ type: "REGION", region: "Kerala", ...base } as ScopeGrant], "actor-1", vendor)).toBe(true);
    expect(isVendorDocInScope([{ type: "REGION", region: "Goa", ...base } as ScopeGrant], "actor-1", vendor)).toBe(false);
    expect(isVendorDocInScope([{ type: "TEAM", teamId: "team-a", ...base } as ScopeGrant], "actor-1", vendor)).toBe(true);
    expect(isVendorDocInScope([{ type: "TEAM", teamId: "team-b", ...base } as ScopeGrant], "actor-1", vendor)).toBe(false);
  });
  it("an EXPLICIT_RECORD grant names this Vendor specifically (by uid, resourceType vendor)", () => {
    expect(isVendorDocInScope([{ type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: "vendor-uid-1", ...base } as ScopeGrant], "actor-1", vendor)).toBe(true);
    expect(isVendorDocInScope([{ type: "EXPLICIT_RECORD", resourceType: "vendor", resourceId: "other", ...base } as ScopeGrant], "actor-1", vendor)).toBe(false);
    expect(isVendorDocInScope([{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: "vendor-uid-1", ...base } as ScopeGrant], "actor-1", vendor)).toBe(false);
  });
  it("a PARTNER grant never opens a Vendor (no Partner-relationship scope bridge)", () => {
    expect(isVendorDocInScope([{ type: "PARTNER", partnerId: "vendor-uid-1", ...base } as ScopeGrant], "actor-1", vendor)).toBe(false);
  });
  it("no grants, or a grant that matches nothing, is out of scope - knowing the id grants nothing", () => {
    expect(isVendorDocInScope([], "actor-1", vendor)).toBe(false);
    expect(isVendorDocInScope([{ type: "REGION", region: "Goa", ...base } as ScopeGrant], "actor-1", { ...vendor, regionIds: [], teamIds: [] })).toBe(false);
  });
});
