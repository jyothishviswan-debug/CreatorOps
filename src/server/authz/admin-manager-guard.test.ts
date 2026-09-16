import { describe, expect, it } from "vitest";

import { resolvesToAdminManagerCapability } from "./admin-manager-guard";
import type { AccessGrantDoc, OverrideLookup, UserAccessOverrideDoc } from "./types";

const fullAdminGrant: AccessGrantDoc = {
  role: "super_admin",
  features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
};

const ABSENT: OverrideLookup = { status: "absent" };

describe("resolvesToAdminManagerCapability", () => {
  it("requires active admission - an inactive user never has the capability, regardless of grants", () => {
    expect(resolvesToAdminManagerCapability({ active: false, accessGrant: fullAdminGrant, override: ABSENT, hasGlobalScope: true })).toBe(false);
  });

  it("requires GLOBAL scope even with every feature/action granted", () => {
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: ABSENT, hasGlobalScope: false })).toBe(false);
  });

  it("requires the administration module itself to be viewable", () => {
    const grant: AccessGrantDoc = { role: "partnership_head", features: {} };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: grant, override: ABSENT, hasGlobalScope: true })).toBe(false);
  });

  it("requires every one of the critical Administration actions, not just some", () => {
    const partial: AccessGrantDoc = {
      role: "super_admin",
      // manage_overrides is missing.
      features: { administration: { view: true, actions: { manage_users: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
    };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: partial, override: ABSENT, hasGlobalScope: true })).toBe(false);
  });

  it("resolves true when active, fully granted, and GLOBAL scope is present", () => {
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: ABSENT, hasGlobalScope: true })).toBe(true);
  });

  it("an explicit user override denying one critical action removes the capability", () => {
    const doc: UserAccessOverrideDoc = { uid: "uid-1", version: 1, features: { administration: { actions: { manage_overrides: false } } } };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: { status: "valid", doc }, hasGlobalScope: true })).toBe(false);
  });

  it("an explicit user override can also grant capability a role baseline alone would not", () => {
    const bareGrant: AccessGrantDoc = { role: "partnership_head", features: {} };
    const doc: UserAccessOverrideDoc = {
      uid: "uid-1",
      version: 1,
      features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
    };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: bareGrant, override: { status: "valid", doc }, hasGlobalScope: true })).toBe(true);
  });

  // Step 5B.1A: a malformed override document must never be silently
  // treated as "no overrides" here either - if it were, a target whose
  // override doc happens to be corrupt could be misjudged as still
  // having (or still lacking) Administration-manager capability based on
  // role baseline alone, when the fail-closed rule says their real,
  // current capability is none until the document is corrected.
  it("an invalid override document denies capability outright, even with a fully-granting role baseline and GLOBAL scope", () => {
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: { status: "invalid" }, hasGlobalScope: true })).toBe(false);
  });
});
