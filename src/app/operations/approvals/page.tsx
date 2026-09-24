import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { computeOperationsPermissions, listApprovalQueue } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { OPERATIONS_TABS } from "@/features/operations/operations-tabs";
import { ApprovalQueueWorkspace } from "@/features/operations-approvals/ApprovalQueueWorkspace";

// Step 18B: /operations/approvals - the Approval Queue. A live, read-only projection built on Step
// 18A's zero-persistence service (mirrors src/app/finance/payments/page.tsx's own server-resolves-
// actor-then-reads-directly shape). No Create action anywhere on this page - see the spec's own
// "This is a live read model over authoritative source modules" and ApprovalQueueWorkspace.tsx's
// own top comment for why no mutation ever belongs here.
export default async function OperationsApprovalsPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeOperationsPermissions(actor);
  const result = permissions.canViewApprovalQueue ? await listApprovalQueue(actor, {}) : null;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / APPROVAL QUEUE</div>
          <h1>Approval Queue</h1>
          <p>Review items that need action in their source module.</p>
        </div>
      </div>

      <ModuleTabs tabs={OPERATIONS_TABS} />

      <ApprovalQueueWorkspace initial={result && result.ok ? { items: result.data.items, notices: result.data.notices } : { items: [], notices: [] }} canView={permissions.canViewApprovalQueue} />
    </AppShell>
  );
}
