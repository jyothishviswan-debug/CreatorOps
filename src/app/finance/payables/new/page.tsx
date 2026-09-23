import Link from "next/link";

import { PayableCreatePage } from "@/features/finance-payables/create";
import { computePayablePermissions } from "@/server/finance-payables";
import { resolveRequestActor } from "@/server/finance-payables/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/payables/new - the ONE canonical Create Payable flow: a three-stage in-page workflow
// (Source -> Review amount -> Confirm), never a vertical stepper. Access is decided here, on the
// server, BEFORE anything renders: the proxy already gates /finance/**, and this page re-checks through
// computePayablePermissions and shows ONE neutral denied state when the actor cannot manage_payables.
// Mirrors the Finance Agreements "New Agreement" route's own access pattern. No ModuleTabs here,
// consistent with every other module's create/detail page (see FinancePageShell's own comment).
export default async function NewPayablePage() {
  const actor = await resolveRequestActor();
  const permissions = await computePayablePermissions(actor);

  if (!permissions.canManage) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FINANCE / PAYABLES / NEW PAYABLE</div>
            <h1>Create Payable</h1>
            <p>Choose the commercial source and period. CreatorOps will use the pinned Agreement and finalized evidence to prepare the payable.</p>
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
      <PayableCreatePage permissions={permissions} />
    </AppShell>
  );
}
