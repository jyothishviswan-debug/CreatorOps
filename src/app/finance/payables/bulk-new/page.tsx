import Link from "next/link";

import { PayableBulkCreatePage } from "@/features/finance-payables/create/PayableBulkCreatePage";
import { computePayablePermissions } from "@/server/finance-payables";
import { resolveRequestActor } from "@/server/finance-payables/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/payables/bulk-new - finding #62: bulk Create Payable. Same server-side access gate as the
// single-item /finance/payables/new (computePayablePermissions().canManage), decided before anything
// renders. The page itself is a thin shell; all bulk logic lives in PayableBulkCreatePage, which talks
// to POST /api/finance/payables/bulk - the server orchestrates, the browser sends one request.
export default async function BulkNewPayablePage() {
  const actor = await resolveRequestActor();
  const permissions = await computePayablePermissions(actor);

  if (!permissions.canManage) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FINANCE / PAYABLES / BULK CREATE</div>
            <h1>Create multiple Payables</h1>
            <p>Select several counterparties and periods, and CreatorOps will prepare every eligible payable in one action.</p>
          </div>
          <div className="actions">
            <Link href="/finance/payables" className="btn">
              Back to Payables
            </Link>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Access denied" description="You do not have access to this view." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / PAYABLES / BULK CREATE</div>
          <h1>Create multiple Payables</h1>
          <p>Select several counterparties and periods, and CreatorOps will prepare every eligible payable in one action - the same canonical rules as a single Create Payable, applied per item.</p>
        </div>
        <div className="actions">
          <Link href="/finance/payables" className="btn">
            Back to Payables
          </Link>
        </div>
      </div>
      <PayableBulkCreatePage />
    </AppShell>
  );
}
