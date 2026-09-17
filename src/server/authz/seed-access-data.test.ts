import { afterEach, describe, expect, it, vi } from "vitest";

const { isUsingEmulatorsMock, getServerEnvMock, getUserByEmailMock, setMock, deleteMock, docMock, collectionMock } = vi.hoisted(() => {
  const setMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  // Simulates "no existing user doc yet" for every getUserDoc() lookup -
  // seedAccessControlData reads before writing to decide whether to reuse
  // an existing userRef; these tests all seed from a clean slate.
  const getMock = vi.fn().mockResolvedValue({ exists: false, data: () => undefined });
  const docMock = vi.fn(() => ({ set: setMock, delete: deleteMock, get: getMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  return {
    isUsingEmulatorsMock: vi.fn(),
    getServerEnvMock: vi.fn(),
    getUserByEmailMock: vi.fn(),
    setMock,
    deleteMock,
    docMock,
    collectionMock,
  };
});

vi.mock("@/lib/env/server", () => ({
  isUsingEmulators: isUsingEmulatorsMock,
  getServerEnv: getServerEnvMock,
}));

vi.mock("@/server/firebase/admin", () => ({
  getAdminAuth: () => ({ getUserByEmail: getUserByEmailMock }),
  getAdminFirestore: () => ({ collection: collectionMock }),
}));

import { ROLES } from "./roles";
import { seedAccessControlData, TEST_IDENTITIES } from "./seed-access-data";

// Total individual scope grants across all five seeded identities - kept
// in sync with the SCOPE_GRANTS matrix in seed-access-data.ts (Viewer 4,
// Analyst 5, Partnership Manager 6, Partnership Head 10, Super Admin 1).
// A zone-level REGION grant (South/West) was added alongside every
// existing state-level one so a Lead created through the newer
// zone-based Region dropdown is visible to the same identities who could
// already see its state-level equivalent - additive, per identity:
// Viewer +1, Analyst +1, Manager +2, Head +2.
const TOTAL_SCOPE_GRANTS = 4 + 5 + 6 + 10 + 1;

// Kept in sync with USER_OVERRIDES in seed-access-data.ts: viewer,
// analyst and manager each get one representative override document
// written; head and admin get none (and so get their override doc
// deleted instead, in case a prior seed run left one behind).
const IDENTITIES_WITH_OVERRIDES = 3;
const IDENTITIES_WITHOUT_OVERRIDES = TEST_IDENTITIES.length - IDENTITIES_WITH_OVERRIDES;

afterEach(() => {
  vi.clearAllMocks();
});

describe("seedAccessControlData", () => {
  it("refuses to run when emulator env vars aren't set, and writes nothing", async () => {
    isUsingEmulatorsMock.mockReturnValue(false);

    await expect(seedAccessControlData()).rejects.toThrow(/refusing to run/i);
    expect(setMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("refuses to run when the resolved project id isn't the local demo project", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "creatorops-b83c0" });

    await expect(seedAccessControlData()).rejects.toThrow(/demo project/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("writes an accessGrants and sensitiveAccessGrants document for every role, and a users document for every test identity", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
    getUserByEmailMock.mockImplementation(async (email: string) => ({ uid: `uid-${email}` }));

    await seedAccessControlData();

    for (const role of ROLES) {
      expect(collectionMock).toHaveBeenCalledWith("accessGrants");
      expect(docMock).toHaveBeenCalledWith(role);
      expect(collectionMock).toHaveBeenCalledWith("sensitiveAccessGrants");
    }
    for (const identity of TEST_IDENTITIES) {
      expect(collectionMock).toHaveBeenCalledWith("users");
      expect(docMock).toHaveBeenCalledWith(`uid-${identity.email}`);
    }
    // 5 roles * 2 collections (accessGrants + sensitiveAccessGrants) +
    // 5 identity user docs + every individual scope grant document +
    // one userAccessOverrides doc per identity that has an override.
    expect(setMock).toHaveBeenCalledTimes(ROLES.length * 2 + TEST_IDENTITIES.length + TOTAL_SCOPE_GRANTS + IDENTITIES_WITH_OVERRIDES);
  });

  it("gives Super Admin's own document every feature explicitly, rather than deriving it from the other roles", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
    getUserByEmailMock.mockImplementation(async (email: string) => ({ uid: `uid-${email}` }));

    await seedAccessControlData();

    const superAdminCall = setMock.mock.calls.find((call) => call[0]?.role === "super_admin" && "features" in call[0]);
    expect(superAdminCall).toBeDefined();
    const doc = superAdminCall![0];
    expect(Object.keys(doc.features).length).toBeGreaterThanOrEqual(15);
    expect(Object.values(doc.features).every((f: unknown) => (f as { view: boolean }).view === true)).toBe(true);
  });

  it("deletes the old Step 4B flat scopeAssignments/{uid} document for every identity as part of migrating to the new model", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
    getUserByEmailMock.mockImplementation(async (email: string) => ({ uid: `uid-${email}` }));

    await seedAccessControlData();

    // One old scopeAssignments/{uid} delete per identity, plus one
    // userAccessOverrides/{uid} delete for every identity that has no
    // representative override configured this run.
    expect(deleteMock).toHaveBeenCalledTimes(TEST_IDENTITIES.length + IDENTITIES_WITHOUT_OVERRIDES);
    for (const identity of TEST_IDENTITIES) {
      expect(collectionMock).toHaveBeenCalledWith("scopeAssignments");
      expect(docMock).toHaveBeenCalledWith(`uid-${identity.email}`);
    }
  });

  it("writes Super Admin's scope as an explicit GLOBAL grant document, not derived from any other role's data", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
    getUserByEmailMock.mockImplementation(async (email: string) => ({ uid: `uid-${email}` }));

    await seedAccessControlData();

    const superAdminUid = "uid-admin@creatorops.com";
    const globalGrantCall = setMock.mock.calls.find((call) => call[0]?.type === "GLOBAL" && call[0]?.uid === superAdminUid);
    expect(globalGrantCall).toBeDefined();

    // No other identity received a GLOBAL grant.
    const otherGlobalGrants = setMock.mock.calls.filter((call) => call[0]?.type === "GLOBAL" && call[0]?.uid !== superAdminUid);
    expect(otherGlobalGrants).toHaveLength(0);
  });

  it("writes multiple simultaneous scope grants of different types for the same identity", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
    getUserByEmailMock.mockImplementation(async (email: string) => ({ uid: `uid-${email}` }));

    await seedAccessControlData();

    const headUid = "uid-head@creatorops.com";
    // Exclude the users/{uid} document itself (uid matches too, but it has
    // no `type` field - only actual scope grant documents do).
    const headGrantTypes = setMock.mock.calls.filter((call) => call[0]?.uid === headUid && call[0]?.type).map((call) => call[0].type);
    expect(new Set(headGrantTypes)).toEqual(new Set(["REGION", "TEAM", "CAMPAIGN", "EXPLICIT_RECORD"]));
  });
});
