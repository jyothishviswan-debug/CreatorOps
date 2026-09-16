import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdministrationAccessMock, listAuditEventsMock } = vi.hoisted(() => ({
  requireAdministrationAccessMock: vi.fn(),
  listAuditEventsMock: vi.fn(),
}));

vi.mock("@/server/authz/administration-gate", () => ({ requireAdministrationAccess: requireAdministrationAccessMock }));
vi.mock("@/server/authz/audit", () => ({ listAuditEvents: listAuditEventsMock }));

import { listAuditEventsForReview } from "./audit-service";
import type { ActorContext, AuditEvent } from "@/server/authz/types";

const actor: ActorContext = { uid: "uid-1", email: "admin@creatorops.com", role: "super_admin", displayName: "Admin", userRef: "ref-1" };

const event: AuditEvent = {
  operation: "user.role_change",
  actorUid: "uid-1",
  actorUserRef: "ref-1",
  actorEmail: "admin@creatorops.com",
  targetUid: "uid-2",
  targetUserRef: "ref-2",
  targetEmail: "manager@creatorops.com",
  targetRole: "partnership_head",
  before: { role: "partnership_manager" },
  after: { role: "partnership_head" },
  requestId: "req-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("listAuditEventsForReview", () => {
  it("is denied the same way requireAdministrationAccess denies it (view_audit is its own capability)", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: false, reason: "action_denied" });
    const result = await listAuditEventsForReview(actor, {});
    expect(result).toEqual({ ok: false, code: "unauthorized", message: expect.any(String), reason: "action_denied" });
    expect(listAuditEventsMock).not.toHaveBeenCalled();
    expect(requireAdministrationAccessMock).toHaveBeenCalledWith(actor, "view_audit");
  });

  it("rejects an out-of-range page size", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    const result = await listAuditEventsForReview(actor, { limit: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("maps every event to a DTO that never exposes a raw Firebase uid", async () => {
    requireAdministrationAccessMock.mockResolvedValue({ ok: true });
    listAuditEventsMock.mockResolvedValue({ events: [event], nextCursor: { createdAt: event.createdAt, requestId: event.requestId } });

    const result = await listAuditEventsForReview(actor, { limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.events).toEqual([
      {
        operation: "user.role_change",
        actorUserRef: "ref-1",
        actorEmail: "admin@creatorops.com",
        targetUserRef: "ref-2",
        targetEmail: "manager@creatorops.com",
        targetRole: "partnership_head",
        before: { role: "partnership_manager" },
        after: { role: "partnership_head" },
        requestId: "req-1",
        createdAt: event.createdAt,
      },
    ]);
    expect(JSON.stringify(result.data.events)).not.toContain("uid-1");
    expect(JSON.stringify(result.data.events)).not.toContain("uid-2");
  });
});
