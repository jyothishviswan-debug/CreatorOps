import Link from "next/link";

import { InvoiceCreatePage } from "@/features/finance-invoices/create";
import { computeInvoicePermissions } from "@/server/finance-invoices";
import { resolveRequestActor } from "@/server/finance-invoices/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/invoices/new - the ONE canonical Create Invoice flow: a four-stage in-page workflow
// (Source Payable -> Invoice Details -> Reconciliation -> Confirm), never a vertical stepper.
// Access is decided here, on the server, BEFORE anything renders: the proxy already gates
// /finance/**, and this page re-checks through computeInvoicePermissions and shows ONE neutral
// denied state when the actor cannot manage_invoices. No ModuleTabs here, consistent with every
// other module's create/detail page (see FinancePageShell's own comment).
export default async function NewInvoicePage() {
  const actor = await resolveRequestActor();
  const permissions = await computeInvoicePermissions(actor);

  if (!permissions.canManage) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FINANCE / INVOICES / NEW INVOICE</div>
            <h1>Create Invoice</h1>
            <p>Choose a Payable that is ready for invoicing.</p>
          </div>
          <div className="actions">
            <Link href="/finance/invoices" className="btn">
              Back to Invoices
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
      <InvoiceCreatePage permissions={permissions} />
    </AppShell>
  );
}
