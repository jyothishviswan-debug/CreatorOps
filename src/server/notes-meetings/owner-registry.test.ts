import { describe, expect, it } from "vitest";

import { isSupportedOwnerType, ownerToOperationsTarget, OWNER_TYPE_REGISTRY, OWNER_TYPES } from "./owner-registry";

describe("OWNER_TYPE_REGISTRY - the required before-state classification (spec section 3)", () => {
  it("classifies exactly the spec's prioritized six as SUPPORTED, and the rest as FUTURE", () => {
    const supported = OWNER_TYPES.filter((t) => OWNER_TYPE_REGISTRY[t].classification === "SUPPORTED").sort();
    expect(supported).toEqual(["ASSIGNMENT", "CAMPAIGN", "CONTENT", "DISCOVERY_LEAD", "PARTNER", "VENDOR"].sort());

    const future = OWNER_TYPES.filter((t) => OWNER_TYPE_REGISTRY[t].classification === "FUTURE").sort();
    expect(future).toEqual(["PARTNER_REVIEW", "FINANCE_AGREEMENT", "OPERATIONS_TASK"].sort());
  });

  it("every SUPPORTED owner type names a real FeatureId; every FUTURE owner type names none (missing context fails closed)", () => {
    for (const type of OWNER_TYPES) {
      const def = OWNER_TYPE_REGISTRY[type];
      if (def.classification === "SUPPORTED") expect(def.feature).not.toBeNull();
      else expect(def.feature).toBeNull();
    }
  });

  it("every entry carries a non-empty documented reasoning string (section 3's classification discipline)", () => {
    for (const type of OWNER_TYPES) expect(OWNER_TYPE_REGISTRY[type].reasoning.length).toBeGreaterThan(10);
  });
});

describe("isSupportedOwnerType", () => {
  it("accepts only SUPPORTED types, rejects FUTURE types and garbage strings", () => {
    expect(isSupportedOwnerType("PARTNER")).toBe(true);
    expect(isSupportedOwnerType("DISCOVERY_LEAD")).toBe(true);
    expect(isSupportedOwnerType("PARTNER_REVIEW")).toBe(false);
    expect(isSupportedOwnerType("NOT_A_REAL_TYPE")).toBe(false);
    expect(isSupportedOwnerType("")).toBe(false);
  });
});

describe("ownerToOperationsTarget - the promotion target mapping (spec section 12's documented DISCOVERY_LEAD choice)", () => {
  it("maps every SUPPORTED owner type to a real Operations TargetReference, reusing the SAME opaque ref", () => {
    for (const type of ["DISCOVERY_LEAD", "PARTNER", "VENDOR", "CAMPAIGN", "ASSIGNMENT", "CONTENT"] as const) {
      const target = ownerToOperationsTarget({ ownerType: type, ownerRef: "ref_123" });
      expect(target).not.toBeNull();
      expect(target!.targetRef).toBe("ref_123");
      expect(target!.targetType).toBe(type);
    }
  });

  it("returns null for a FUTURE owner type - promotion is refused up front, never producing an unresolvable target", () => {
    for (const type of ["PARTNER_REVIEW", "FINANCE_AGREEMENT", "OPERATIONS_TASK"] as const) {
      expect(ownerToOperationsTarget({ ownerType: type, ownerRef: "ref_123" })).toBeNull();
    }
  });
});
