import { z } from "zod";

import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { listAuditEvents, type AuditEventListCursor } from "@/server/authz/audit";
import type { ActorContext, AuditEvent } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

const listAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.object({ createdAt: z.string().min(1), requestId: z.string().min(1) }).optional(),
});

export type ListAuditInput = z.input<typeof listAuditInputSchema>;

// The audit trail's own client-facing shape - same rule as everywhere
// else: opaque userRef only, the raw Firebase uid never leaves the server
// even in a durable, server-only collection's own review API.
export type AuditEventDto = {
  operation: string;
  actorUserRef: string;
  actorEmail: string;
  targetUserRef?: string;
  targetEmail?: string;
  targetRole?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

function toAuditEventDto(event: AuditEvent): AuditEventDto {
  return {
    operation: event.operation,
    actorUserRef: event.actorUserRef,
    actorEmail: event.actorEmail,
    targetUserRef: event.targetUserRef,
    targetEmail: event.targetEmail,
    targetRole: event.targetRole,
    before: event.before,
    after: event.after,
    requestId: event.requestId,
    createdAt: event.createdAt,
  };
}

export async function listAuditEventsForReview(
  actor: ActorContext | null,
  rawInput: unknown,
): Promise<ServiceResult<{ events: AuditEventDto[]; nextCursor: AuditEventListCursor | null }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "view_audit");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsed = listAuditInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));

  const page = await listAuditEvents({ limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor });
  return { ok: true, data: { events: page.events.map(toAuditEventDto), nextCursor: page.nextCursor } };
}
