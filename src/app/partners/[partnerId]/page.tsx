import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { PartnerDetail } from "@/features/partners/PartnerDetail";
import { resolveRequestActor } from "@/server/partners/http";
import { getPartner } from "@/server/partners/partner-service";

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

  return (
    <AppShell>
      <PartnerDetail initialPartner={result.data} />
    </AppShell>
  );
}
