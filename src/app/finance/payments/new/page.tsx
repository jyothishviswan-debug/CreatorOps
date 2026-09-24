import Link from "next/link";

import { PaymentCreatePage } from "@/features/finance-payments/create";
import { computePaymentPermissions } from "@/server/finance-payments";
import { resolveRequestActor } from "@/server/finance-payments/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/payments/new - the ONE canonical Record Payment flow: a three-stage in-page workflow
// (Source Invoice -> Payment Details -> Confirm), never a vertical stepper. Access is decided here,
// on the server, BEFORE anything renders: the proxy already gates /finance/**, and this page
// re-checks through computePaymentPermissions and shows ONE neutral denied state when the actor
// cannot manage_payments. No ModuleTabs here, consistent with every other module's create/detail
// page (see FinancePageShell's own comment).
export default async function NewPaymentPage() {
  const actor = await resolveRequestActor();
  const permissions = await computePaymentPermissions(actor);

  if (!permissions.canManage) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FINANCE / PAYMENTS / RECORD PAYMENT</div>
            <h1>Record Payment</h1>
            <p>Choose an approved Invoice with an outstanding balance.</p>
          </div>
          <div className="actions">
            <Link href="/finance/payments" className="btn">
              Back to Payments
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
      <PaymentCreatePage permissions={permissions} />
    </AppShell>
  );
}
