import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { VendorDetail } from "@/features/vendors/VendorDetail";
import { resolveRequestActor } from "@/server/vendors/http";
import { getVendor } from "@/server/vendors/vendor-service";
import { canAccessFeature } from "@/server/authz/capabilities";

export default async function VendorDetailPage({ params }: { params: Promise<{ vendorId: string }> }) {
  const { vendorId } = await params;
  const actor = await resolveRequestActor();
  const result = await getVendor(actor, vendorId);

  if (!result.ok && result.code === "not_found") notFound();

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Vendor." icon="lock" />
        </section>
      </AppShell>
    );
  }

  // The contextual Finance Agreements link (Payee / Commercial Context tab) is shown only to an actor who holds the Finance feature.
  const canOpenFinance = actor ? await canAccessFeature(actor, "finance") : false;

  return (
    <AppShell>
      <VendorDetail initialVendor={result.data} canOpenFinance={canOpenFinance} />
    </AppShell>
  );
}
