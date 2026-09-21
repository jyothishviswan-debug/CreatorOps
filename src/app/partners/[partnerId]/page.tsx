import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { PartnerDetail } from "@/features/partners/PartnerDetail";
import { resolveRequestActor } from "@/server/partners/http";
import { getPartner } from "@/server/partners/partner-service";
import { canAccessFeature } from "@/server/authz/capabilities";
import { listCounterpartyAgreementDocuments } from "@/server/finance-agreements";

export default async function PartnerDetailPage({ params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  const actor = await resolveRequestActor();
  const result = await getPartner(actor, partnerId);

  if (!result.ok && result.code === "not_found") notFound();

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Partner." icon="lock" />
        </section>
      </AppShell>
    );
  }

  // The contextual "Partner Reviews" link (Context tab) is shown only to an actor who holds the Partner Reviews feature.
  const canOpenPartnerReviews = actor ? await canAccessFeature(actor, "partner_reviews") : false;

  // Likewise the contextual Finance Agreements links (Context tab): rendered only for an actor who holds the Finance feature.
  const canOpenFinance = actor ? await canAccessFeature(actor, "finance") : false;

  // Step 14B.1: the signed Agreement documents of this Partner (the same stored file the Finance detail shows). Read ONLY for an actor who holds the
  // Finance feature - the projection re-checks the feature and this Partner's live scope itself, and includes a link only for a holder of the
  // contract-detail category. Profile access alone never reads it; a refusal or failure simply leaves the Finance tile as it was (null).
  const agreementDocuments = canOpenFinance ? await loadAgreementDocuments(actor, result.data.partnerRef) : null;

  return (
    <AppShell>
      <PartnerDetail initialPartner={result.data} canOpenPartnerReviews={canOpenPartnerReviews} canOpenFinance={canOpenFinance} agreementDocuments={agreementDocuments} />
    </AppShell>
  );
}

async function loadAgreementDocuments(actor: Awaited<ReturnType<typeof resolveRequestActor>>, partnerRef: string) {
  try {
    const documents = await listCounterpartyAgreementDocuments(actor, { counterpartyType: "PARTNER", ref: partnerRef });
    return documents.ok ? documents.data : null;
  } catch {
    return null;
  }
}
