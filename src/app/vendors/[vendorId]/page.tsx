import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { VendorDetail } from "@/features/vendors/VendorDetail";
import { resolveRequestActor } from "@/server/vendors/http";
import { getVendor } from "@/server/vendors/vendor-service";
import { canAccessFeature } from "@/server/authz/capabilities";
import { listCounterpartyAgreementDocuments } from "@/server/finance-agreements";

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

  // Step 14B.1: the signed Agreement documents of this Vendor (the same stored file the Finance detail shows). Read ONLY for an actor who holds the
  // Finance feature - the projection re-checks the feature and this Vendor's live scope itself, and includes a link only for a holder of the
  // contract-detail category. Profile access alone never reads it; a refusal or failure simply leaves the panel as it was (null).
  const agreementDocuments = canOpenFinance ? await loadAgreementDocuments(actor, result.data.vendorRef) : null;

  return (
    <AppShell>
      <VendorDetail initialVendor={result.data} canOpenFinance={canOpenFinance} agreementDocuments={agreementDocuments} />
    </AppShell>
  );
}

async function loadAgreementDocuments(actor: Awaited<ReturnType<typeof resolveRequestActor>>, vendorRef: string) {
  try {
    const documents = await listCounterpartyAgreementDocuments(actor, { counterpartyType: "VENDOR", ref: vendorRef });
    return documents.ok ? documents.data : null;
  } catch {
    return null;
  }
}
