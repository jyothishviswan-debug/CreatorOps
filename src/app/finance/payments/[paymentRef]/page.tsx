import { notFound } from "next/navigation";

import { PaymentDetail, parseDetailTab } from "@/features/finance-payments/detail";
import { computePaymentPermissions, getPayment } from "@/server/finance-payments";
import { resolveRequestActor } from "@/server/finance-payments/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/payments/[paymentRef]?tab= - the main ongoing Payment record screen (never the create
// flow after creation). Access is decided HERE, on the server, before anything renders: an
// out-of-scope, missing or forged ref and a feature/action denial both look the SAME neutral state
// (not_found / unauthorized already carry that neutral shape from the service layer). No
// ModuleTabs here, matching every other module's detail page (see FinancePageShell's own comment) -
// the Payments tab is current only on the workspace route.
export default async function PaymentDetailPage({ params, searchParams }: { params: Promise<{ paymentRef: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { paymentRef } = await params;
  const { tab } = await searchParams;
  const actor = await resolveRequestActor();

  const [result, permissions] = await Promise.all([getPayment(actor, paymentRef), computePaymentPermissions(actor)]);

  if (!result.ok) {
    if (result.code === "unauthorized") return <Denied />;
    if (result.code === "not_found" || result.code === "invalid_input") notFound();
    return <LoadFailed />;
  }
  if (!permissions.canView) return <Denied />;

  return (
    <AppShell>
      <PaymentDetail initial={result.data} permissions={permissions} initialTab={parseDetailTab(tab)} />
    </AppShell>
  );
}

function Denied() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Access denied" description="You don't have permission to view this Payment." icon="lock" />
      </section>
    </AppShell>
  );
}

function LoadFailed() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Couldn’t load this Payment" description="Something went wrong while loading it. Try again in a moment." icon="alert" />
      </section>
    </AppShell>
  );
}
