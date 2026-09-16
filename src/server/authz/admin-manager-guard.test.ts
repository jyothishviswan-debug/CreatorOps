import { describe, expect, it } from "vitest";

import { resolvesToAdminManagerCapability } from "./admin-manager-guard";
import type { AccessGrantDoc, UserAccessOverrideDoc } from "./types";

const fullAdminGrant: AccessGrantDoc = {
  role: "super_admin",
  features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
};

describe("resolvesToAdminManagerCapability", () => {
  it("requires active admission - an inactive user never has the capability, regardless of grants", () => {
    expect(resolvesToAdminManagerCapability({ active: false, accessGrant: fullAdminGrant, override: null, hasGlobalScope: true })).toBe(false);
  });

  it("requires GLOBAL scope even with every feature/action granted", () => {
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: null, hasGlobalScope: false })).toBe(false);
  });

  it("requires the administration module itself to be viewable", () => {
    const grant: AccessGrantDoc = { role: "partnership_head", features: {} };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: grant, override: null, hasGlobalScope: true })).toBe(false);
  });

  it("requires every one of the critical Administration actions, not just some", () => {
    const partial: AccessGrantDoc = {
      role: "super_admin",
      // manage_overrides is missing.
      features: { administration: { view: true, actions: { manage_users: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
    };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: partial, override: null, hasGlobalScope: true })).toBe(false);
  });

  it("resolves true when active, fully granted, and GLOBAL scope is present", () => {
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override: null, hasGlobalScope: true })).toBe(true);
  });

  it("an explicit user override denying one critical action removes the capability", () => {
    const override: UserAccessOverrideDoc = { uid: "uid-1", version: 1, features: { administration: { actions: { manage_overrides: false } } } };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: fullAdminGrant, override, hasGlobalScope: true })).toBe(false);
  });

  it("an explicit user override can also grant capability a role baseline alone would not", () => {
    const bareGrant: AccessGrantDoc = { role: "partnership_head", features: {} };
    const override: UserAccessOverrideDoc = {
      uid: "uid-1",
      version: 1,
      features: { administration: { view: true, actions: { manage_users: true, manage_overrides: true, manage_scope: true, manage_sensitive: true, view_audit: true } } },
    };
    expect(resolvesToAdminManagerCapability({ active: true, accessGrant: bareGrant, override, hasGlobalScope: true })).toBe(true);
  });
});
