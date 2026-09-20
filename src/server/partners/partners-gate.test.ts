import { describe, expect, it } from "vitest";

import type { ScopeGrant } from "@/server/authz/types";

import { isPartnerDocInScope } from "./partners-gate";

// Step 12E: the pure Partner Record Scope decision (requirePartnerInScope
// delegates to it), exercised with in-memory grants - no Firestore. Behavior
// is identical to the previous inline implementation: GLOBAL, SELF via
// ownerUid, REGION/TEAM via the Partner's own dimensions, a PARTNER grant
// naming this Partner's uid, or an EXPLICIT_RECORD grant for it.
const base = { uid: "actor-1", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "system:test" };
const partner = { uid: "partner-uid-1", ownerUid: "owner-1" as string | null, regionIds: ["Kerala"], teamIds: ["team-a"] };

describe("isPartnerDocInScope", () => {
  it("a GLOBAL grant sees every Partner", () => {
    expect(isPartnerDocInScope([{ type: "GLOBAL", ...base } as ScopeGrant], "actor-1", partner)).toBe(true);
  });
  it("SELF grant: only the Partner's owner", () => {
    const self = [{ type: "SELF", ...base } as ScopeGrant];
    expect(isPartnerDocInScope(self, "owner-1", partner)).toBe(true);
    expect(isPartnerDocInScope(self, "someone-else", partner)).toBe(false);
    expect(isPartnerDocInScope(self, "owner-1", { ...partner, ownerUid: null })).toBe(false);
  });
  it("REGION and TEAM grants match the Partner's own dimensions", () => {
    expect(isPartnerDocInScope([{ type: "REGION", region: "Kerala", ...base } as ScopeGrant], "actor-1", partner)).toBe(true);
    expect(isPartnerDocInScope([{ type: "REGION", region: "Goa", ...base } as ScopeGrant], "actor-1", partner)).toBe(false);
    expect(isPartnerDocInScope([{ type: "TEAM", teamId: "team-a", ...base } as ScopeGrant], "actor-1", partner)).toBe(true);
    expect(isPartnerDocInScope([{ type: "TEAM", teamId: "team-b", ...base } as ScopeGrant], "actor-1", partner)).toBe(false);
  });
  it("the dedicated PARTNER grant and an EXPLICIT_RECORD grant each name this Partner specifically", () => {
    expect(isPartnerDocInScope([{ type: "PARTNER", partnerId: "partner-uid-1", ...base } as ScopeGrant], "actor-1", partner)).toBe(true);
    expect(isPartnerDocInScope([{ type: "PARTNER", partnerId: "other", ...base } as ScopeGrant], "actor-1", partner)).toBe(false);
    expect(isPartnerDocInScope([{ type: "EXPLICIT_RECORD", resourceType: "partner", resourceId: "partner-uid-1", ...base } as ScopeGrant], "actor-1", partner)).toBe(true);
    expect(isPartnerDocInScope([{ type: "EXPLICIT_RECORD", resourceType: "campaign", resourceId: "partner-uid-1", ...base } as ScopeGrant], "actor-1", partner)).toBe(false);
  });
  it("no grants, or a grant that matches nothing, is out of scope - knowing the id grants nothing", () => {
    expect(isPartnerDocInScope([], "actor-1", partner)).toBe(false);
    expect(isPartnerDocInScope([{ type: "REGION", region: "Goa", ...base } as ScopeGrant], "actor-1", { ...partner, regionIds: [], teamIds: [] })).toBe(false);
  });
});
