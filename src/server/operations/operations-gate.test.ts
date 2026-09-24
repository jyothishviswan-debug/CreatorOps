import { describe, expect, it } from "vitest";

import type { ActorContext, ScopeGrant } from "@/server/authz/types";

import { isOperationsRecordInScope } from "./operations-gate";

const actor: ActorContext = { uid: "uid_actor", email: "actor@creatorops.com", role: "partnership_manager", displayName: "Actor", userRef: "user_actor" };

function record(overrides: Partial<Parameters<typeof isOperationsRecordInScope>[2]> = {}) {
  return { ownerUid: null, regionIds: [], teamIds: [], createdByUserRef: "user_someone_else", ...overrides };
}

describe("isOperationsRecordInScope", () => {
  it("is denied with no grants and no relationship to the record", () => {
    expect(isOperationsRecordInScope([], actor, record())).toBe(false);
  });

  it("GLOBAL always grants access", () => {
    const grants: ScopeGrant[] = [{ type: "GLOBAL", uid: actor.uid, grantedAt: "now", grantedBy: "system" }];
    expect(isOperationsRecordInScope(grants, actor, record())).toBe(true);
  });

  it("SELF grants access when the actor is the record's ownerUid (the primary assignee/recipient)", () => {
    const grants: ScopeGrant[] = [{ type: "SELF", uid: actor.uid, grantedAt: "now", grantedBy: "system" }];
    expect(isOperationsRecordInScope(grants, actor, record({ ownerUid: actor.uid }))).toBe(true);
    expect(isOperationsRecordInScope(grants, actor, record({ ownerUid: "someone-else" }))).toBe(false);
  });

  it("the creator can always see what they created, even with zero scope grants", () => {
    expect(isOperationsRecordInScope([], actor, record({ createdByUserRef: actor.userRef }))).toBe(true);
  });

  it("a REGION grant matches when the record carries that region", () => {
    const grants: ScopeGrant[] = [{ type: "REGION", region: "west", uid: actor.uid, grantedAt: "now", grantedBy: "system" }];
    expect(isOperationsRecordInScope(grants, actor, record({ regionIds: ["west"] }))).toBe(true);
    expect(isOperationsRecordInScope(grants, actor, record({ regionIds: ["east"] }))).toBe(false);
  });

  it("a TEAM grant matches when the record carries that team", () => {
    const grants: ScopeGrant[] = [{ type: "TEAM", teamId: "team-1", uid: actor.uid, grantedAt: "now", grantedBy: "system" }];
    expect(isOperationsRecordInScope(grants, actor, record({ teamIds: ["team-1"] }))).toBe(true);
    expect(isOperationsRecordInScope(grants, actor, record({ teamIds: ["team-2"] }))).toBe(false);
  });

  it("an unrelated PARTNER/EXPLICIT_RECORD grant does not leak access to a Task/Reminder (Operations scope is its own dimension set)", () => {
    const grants: ScopeGrant[] = [{ type: "PARTNER", partnerId: "partner-1", uid: actor.uid, grantedAt: "now", grantedBy: "system" }];
    expect(isOperationsRecordInScope(grants, actor, record())).toBe(false);
  });
});
