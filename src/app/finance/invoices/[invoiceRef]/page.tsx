import { notFound } from "next/navigation";

import { InvoiceDetail, parseDetailTab } from "@/features/finance-invoices/detail";
import { computeInvoicePermissions, getInvoice, getInvoiceSourceRevision } from "@/server/finance-invoices";
import { resolveRequestActor } from "@/server/finance-invoices/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/invoices/[invoiceRef]?tab= - the main ongoing Invoice record screen (never the create
// wizard after creation). Access is decided HERE, on the server, before anything renders: an
// out-of-scope, missing or forged ref and a feature/action denial both look the SAME neutral state
// (not_found / unauthorized already carry that neutral shape from the service layer). No
// ModuleTabs here, matching every other module's detail page (see FinancePageShell's own comment) -
// the Invoices tab is current only on the workspace route.
export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ invoiceRef: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { invoiceRef } = await params;
  const { tab } = await searchParams;
  const actor = await resolveRequestActor();

  const [result, permissions] = await Promise.all([getInvoice(actor, invoiceRef), computeInvoicePermissions(actor)]);

  if (!result.ok) {
    if (result.code === "unauthorized") return <Denied />;
    if (result.code === "not_found" || result.code === "invalid_input") notFound();
    return <LoadFailed />;
  }
  if (!permissions.canView) return <Denied />;

  const revisionResult = await getInvoiceSourceRevision(actor, invoiceRef);

  return (
    <AppShell>
      <InvoiceDetail initial={result.data} permissions={permissions} initialTab={parseDetailTab(tab)} revision={revisionResult.ok ? revisionResult.data : null} />
    </AppShell>
  );
}

function Denied() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Access denied" description="You don't have permission to view this Invoice." icon="lock" />
      </section>
    </AppShell>
  );
}

function LoadFailed() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Couldn’t load this Invoice" description="Something went wrong while loading it. Try again in a moment." icon="alert" />
      </section>
    </AppShell>
  );
}
