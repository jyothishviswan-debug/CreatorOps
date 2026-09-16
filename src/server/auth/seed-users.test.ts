import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isUsingEmulatorsMock, getServerEnvMock, getUserByEmailMock, updateUserMock, createUserMock } = vi.hoisted(() => ({
  isUsingEmulatorsMock: vi.fn(),
  getServerEnvMock: vi.fn(),
  getUserByEmailMock: vi.fn(),
  updateUserMock: vi.fn(),
  createUserMock: vi.fn(),
}));

vi.mock("@/lib/env/server", () => ({
  isUsingEmulators: isUsingEmulatorsMock,
  getServerEnv: getServerEnvMock,
}));

vi.mock("@/server/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUserByEmail: getUserByEmailMock,
    updateUser: updateUserMock,
    createUser: createUserMock,
  }),
}));

import { EMULATOR_TEST_USERS, seedEmulatorTestUsers } from "./seed-users";

beforeEach(() => {
  getServerEnvMock.mockReturnValue({ projectId: "demo-creatorops" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("seedEmulatorTestUsers", () => {
  it("refuses to run when emulator env vars aren't set, and touches no Firebase API", async () => {
    isUsingEmulatorsMock.mockReturnValue(false);

    await expect(seedEmulatorTestUsers("some-password")).rejects.toThrow(/refusing to run/i);

    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("refuses to run when the resolved project id isn't the local demo project (e.g. a leaked .env.production.local value)", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getServerEnvMock.mockReturnValue({ projectId: "creatorops-b83c0" });

    await expect(seedEmulatorTestUsers("some-password")).rejects.toThrow(/doesn't look like the local demo project/i);

    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("creates a user that doesn't exist yet", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getUserByEmailMock.mockRejectedValue(Object.assign(new Error("not found"), { code: "auth/user-not-found" }));

    await seedEmulatorTestUsers("the-password");

    expect(createUserMock).toHaveBeenCalledTimes(EMULATOR_TEST_USERS.length);
    for (const user of EMULATOR_TEST_USERS) {
      expect(createUserMock).toHaveBeenCalledWith(
        expect.objectContaining({ email: user.email, password: "the-password" }),
      );
    }
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("updates a user that already exists instead of creating a duplicate", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getUserByEmailMock.mockResolvedValue({ uid: "existing-uid" });

    await seedEmulatorTestUsers("the-password");

    expect(createUserMock).not.toHaveBeenCalled();
    expect(updateUserMock).toHaveBeenCalledTimes(EMULATOR_TEST_USERS.length);
    expect(updateUserMock).toHaveBeenCalledWith("existing-uid", expect.objectContaining({ password: "the-password" }));
  });

  it("re-throws an unexpected lookup error instead of silently creating a duplicate", async () => {
    isUsingEmulatorsMock.mockReturnValue(true);
    getUserByEmailMock.mockRejectedValue(new Error("emulator unreachable"));

    await expect(seedEmulatorTestUsers("the-password")).rejects.toThrow("emulator unreachable");
    expect(createUserMock).not.toHaveBeenCalled();
  });
});
