import { notFound } from "next/navigation";

import { parseDetailTab, PayableDetail } from "@/features/finance-payables/detail";
import { computePayablePermissions, getPayable, getPayableSourceRevision } from "@/server/finance-payables";
import { resolveRequestActor } from "@/server/finance-payables/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

// /finance/payables/[payableRef]?tab= - the main ongoing Payable record screen (never a wizard after
// creation). Access is decided HERE, on the server, before anything renders: an out-of-scope, missing or
// forged ref and a feature/action denial both look the SAME neutral state (not_found / unauthorized
// already carry that neutral shape from the service layer). No ModuleTabs here, matching every other
// module's detail page (see FinancePageShell's own comment) - the Payables tab is current only on the
// workspace route.
export default async function PayableDetailPage({ params, searchParams }: { params: Promise<{ payableRef: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { payableRef } = await params;
  const { tab } = await searchParams;
  const actor = await resolveRequestActor();

  const [result, permissions] = await Promise.all([getPayable(actor, payableRef), computePayablePermissions(actor)]);

  if (!result.ok) {
    if (result.code === "unauthorized") return <Denied />;
    if (result.code === "not_found" || result.code === "invalid_input") notFound();
    return <LoadFailed />;
  }
  if (!permissions.canView) return <Denied />;

  const revisionResult = await getPayableSourceRevision(actor, payableRef);

  return (
    <AppShell>
      <PayableDetail initial={result.data} permissions={permissions} initialTab={parseDetailTab(tab)} revision={revisionResult.ok ? revisionResult.data : null} />
    </AppShell>
  );
}

function Denied() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Access denied" description="You don't have permission to view this Payable." icon="lock" />
      </section>
    </AppShell>
  );
}

function LoadFailed() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Couldn’t load this Payable" description="Something went wrong while loading it. Try again in a moment." icon="alert" />
      </section>
    </AppShell>
  );
}
