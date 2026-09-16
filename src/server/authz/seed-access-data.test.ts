import { afterEach, describe, expect, it, vi } from "vitest";

const { isUsingEmulatorsMock, getServerEnvMock, getUserByEmailMock, setMock, docMock, collectionMock } = vi.hoisted(() => {
  const setMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({ set: setMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  return {
    isUsingEmulatorsMock: vi.fn(),
    getServerEnvMock: vi.fn(),
    getUserByEmailMock: vi.fn(),
    setMock,
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("seedAccessControlData", () => {
  it("refuses to run when emulator env vars aren't set, and writes nothing", async () => {
    isUsingEmulatorsMock.mockReturnValue(false);

    await expect(seedAccessControlData()).rejects.toThrow(/refusing to run/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("refuses to run when the resolved project id isn't the local demo project", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "creatorops-b83c0" });

    await expect(seedAccessControlData()).rejects.toThrow(/demo project/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("writes an accessGrants and sensitiveAccessGrants document for every role, and a users/scopeAssignments document for every test identity", async () => {
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
      expect(collectionMock).toHaveBeenCalledWith("scopeAssignments");
    }
    // 5 roles * 2 collections + 5 identities * 2 collections = 20 writes.
    expect(setMock).toHaveBeenCalledTimes(ROLES.length * 2 + TEST_IDENTITIES.length * 2);
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
});
