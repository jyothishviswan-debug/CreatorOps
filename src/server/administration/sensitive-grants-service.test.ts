import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdministrationAccessMock, getSensitiveAccessGrantDocMock, writeAuditEventMock, setMock, collectionMock } = vi.hoisted(() => {
  const setMock = vi.fn().mockResolvedValue(undefined);
  const docMock = vi.fn(() => ({ set: setMock }));
  const collectionMock = vi.fn(() => ({ doc: docMock }));
  return {
    requireAdministrationAccessMock: vi.fn(),
    getSensitiveAccessGrantDocMock: vi.fn(),
    writeAuditEventMock: vi.fn().mockResolvedValue(undefined),
    setMock,
    docMock,
    collectionMock,
  };
});

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/firestore", () => ({
  COLLECTIONS: { sensitiveAccessGrants: "sensitiveAccessGrants" },
  getSensitiveAccessGrantDoc: getSensitiveAccessGrantDocMock,
}));
vi.mock("@/server/authz/audit", () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock("@/server/firebase/admin", () => ({ getAdminFirestore: () => ({ collection: collectionMock }) }));

import { addSensitiveGrant, getSensitiveGrants, removeSensitiveGrant } from "./sensitive-grants-service";
import type { ActorContext } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };

afterEach(() => {
  vi.clearAllMocks();
});

describe("getSensitiveGrants", () => {
  it("is denied the same way requireAdministrationAccess denies it", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "feature_denied" });
    const result = await getSensitiveGrants(actor, "partnership_head");
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "feature_denied" });
  });

  it("returns an empty list for a role with no grant document yet", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getSensitiveAccessGrantDocMock.mockResolvedValue(null);
    const result = await getSensitiveGrants(actor, "viewer");
    expect(result).toEqual({ ok: true, data: { role: "viewer", categories: [] } });
  });
});

describe("addSensitiveGrant", () => {
  it("adds a new category and records an audit event (sensitive grant add)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getSensitiveAccessGrantDocMock.mockResolvedValue({ role: "partnership_head", categories: ["finance_amounts"] });

    const result = await addSensitiveGrant(actor, "partnership_head", { category: "partner_pii" }, "req-1");

    expect(result).toEqual({ ok: true, data: { categories: ["finance_amounts", "partner_pii"] } });
    expect(setMock).toHaveBeenCalledWith({ role: "partnership_head", categories: ["finance_amounts", "partner_pii"] });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "sensitive_grant.add",
        targetRole: "partnership_head",
        before: { categories: ["finance_amounts"] },
        after: { categories: ["finance_amounts", "partner_pii"] },
      }),
    );
  });

  it("adding an already-granted category is a no-op (idempotent), still succeeds", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getSensitiveAccessGrantDocMock.mockResolvedValue({ role: "partnership_head", categories: ["finance_amounts"] });

    const result = await addSensitiveGrant(actor, "partnership_head", { category: "finance_amounts" }, "req-1");
    expect(result).toEqual({ ok: true, data: { categories: ["finance_amounts"] } });
  });
});

describe("removeSensitiveGrant", () => {
  it("removes an existing category (sensitive grant remove)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getSensitiveAccessGrantDocMock.mockResolvedValue({ role: "partnership_head", categories: ["finance_amounts", "partner_pii"] });

    const result = await removeSensitiveGrant(actor, "partnership_head", { category: "partner_pii" }, "req-1");

    expect(result).toEqual({ ok: true, data: { categories: ["finance_amounts"] } });
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ operation: "sensitive_grant.remove" }));
  });

  it("returns not_found when the category isn't currently granted", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    getSensitiveAccessGrantDocMock.mockResolvedValue({ role: "viewer", categories: [] });

    const result = await removeSensitiveGrant(actor, "viewer", { category: "finance_amounts" }, "req-1");
    expect(result).toEqual({ ok: false, code: "not_found", message: expect.any(String) });
  });
});
