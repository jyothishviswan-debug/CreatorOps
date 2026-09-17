import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "@/server/authz/test-helpers/fake-firestore";
import { checkForVendorDuplicates } from "./duplicate-check";

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkForVendorDuplicates", () => {
  it("returns 'none' when nothing matches", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    const result = await checkForVendorDuplicates({ email: "nobody@example.com" });
    expect(result.status).toBe("none");
    expect(result.matches).toEqual([]);
  });

  it("returns 'confirmed' with a high-confidence match on an exact email hit", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "vendors/vendor-existing": { vendorRef: "ref-existing", email: "match@example.com" },
      }),
    );
    const result = await checkForVendorDuplicates({ email: "match@example.com" });
    expect(result.status).toBe("confirmed");
    expect(result.matches).toEqual([{ type: "email", ref: "ref-existing", confidence: "high" }]);
  });

  it("phone-only matches are 'possible' (medium confidence), not 'confirmed'", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "vendors/vendor-existing": { vendorRef: "ref-existing", phone: "+911234567890" },
      }),
    );
    const result = await checkForVendorDuplicates({ phone: "+91 12345 67890" });
    expect(result.status).toBe("possible");
    expect(result.matches[0]).toMatchObject({ confidence: "medium" });
  });

  it("a displayName-only match is 'possible', 'low' confidence - never a uniqueness lock", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "vendors/vendor-existing": { vendorRef: "ref-existing", displayNameLower: "northline talent agency" },
      }),
    );
    const result = await checkForVendorDuplicates({ displayName: "Northline Talent Agency" });
    expect(result.status).toBe("possible");
    expect(result.matches[0]).toMatchObject({ type: "displayName", confidence: "low" });
  });

  it("excludes the Vendor being re-checked from its own match set", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "vendors/vendor-self": { vendorRef: "ref-self", email: "self@example.com" },
      }),
    );
    const result = await checkForVendorDuplicates({ email: "self@example.com", excludeVendorUid: "vendor-self" });
    expect(result.status).toBe("none");
  });

  it("a failed lookup is 'unknown', never silently 'none'", async () => {
    getAdminFirestoreMock.mockReturnValue({
      collection: () => ({
        where: () => {
          throw new Error("simulated Firestore failure");
        },
      }),
    });
    const result = await checkForVendorDuplicates({ email: "anyone@example.com" });
    expect(result.status).toBe("unknown");
    expect(result.matches).toEqual([]);
  });
});
