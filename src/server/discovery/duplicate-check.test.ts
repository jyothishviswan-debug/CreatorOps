import { afterEach, describe, expect, it, vi } from "vitest";

const { getAdminFirestoreMock } = vi.hoisted(() => ({ getAdminFirestoreMock: vi.fn() }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: getAdminFirestoreMock }));

import { makeFakeFirestore } from "@/server/authz/test-helpers/fake-firestore";
import { checkForDuplicates } from "./duplicate-check";

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkForDuplicates", () => {
  it("returns 'none' when nothing matches", async () => {
    getAdminFirestoreMock.mockReturnValue(makeFakeFirestore({}));
    const result = await checkForDuplicates({ email: "nobody@example.com" });
    expect(result.status).toBe("none");
    expect(result.matches).toEqual([]);
  });

  it("returns 'confirmed' with a high-confidence match on an exact email hit against an existing Lead", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "leads/lead-existing": { leadRef: "ref-existing", email: "match@example.com" },
      }),
    );
    const result = await checkForDuplicates({ email: "Match@Example.com" });
    expect(result.status).toBe("confirmed");
    expect(result.matches).toEqual([{ type: "email", source: "lead", ref: "ref-existing", confidence: "high" }]);
  });

  it("excludes the Lead being re-checked from its own match set", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "leads/lead-self": { leadRef: "ref-self", email: "self@example.com" },
      }),
    );
    const result = await checkForDuplicates({ email: "self@example.com", excludeLeadUid: "lead-self" });
    expect(result.status).toBe("none");
  });

  it("phone-only matches are 'possible' (medium confidence), not 'confirmed'", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "leads/lead-existing": { leadRef: "ref-existing", phone: "+911234567890" },
      }),
    );
    const result = await checkForDuplicates({ phone: "+91 12345 67890" });
    expect(result.status).toBe("possible");
    expect(result.matches[0]).toMatchObject({ confidence: "medium" });
  });

  it("checks canonical Partners/Partner Accounts too, not just Leads", async () => {
    getAdminFirestoreMock.mockReturnValue(
      makeFakeFirestore({
        "partners/partner-existing": { partnerRef: "ref-partner", email: "creator@example.com" },
        "partnerAccounts/account-existing": { partnerAccountRef: "ref-account", handle: "creatorhandle" },
      }),
    );
    const result = await checkForDuplicates({ email: "creator@example.com", handle: "@CreatorHandle" });
    expect(result.status).toBe("confirmed");
    expect(result.matches).toEqual(
      expect.arrayContaining([
        { type: "email", source: "partner", ref: "ref-partner", confidence: "high" },
        { type: "handle", source: "partner_account", ref: "ref-account", confidence: "high" },
      ]),
    );
  });

  it("a failed lookup is 'unknown', never silently 'none'", async () => {
    getAdminFirestoreMock.mockReturnValue({
      collection: () => ({
        where: () => {
          throw new Error("simulated Firestore failure");
        },
      }),
    });
    const result = await checkForDuplicates({ email: "anyone@example.com" });
    expect(result.status).toBe("unknown");
    expect(result.matches).toEqual([]);
  });
});
