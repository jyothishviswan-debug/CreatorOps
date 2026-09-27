import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { DiscoveryLeadDetail } from "@/features/discovery/DiscoveryLeadDetail";
import { getLeadReadiness } from "@/server/discovery/conversion-service";
import { resolveRequestActor } from "@/server/discovery/http";
import { getLead } from "@/server/discovery/lead-service";
import { computeNotesMeetingsUiPermissions } from "@/server/notes-meetings";

export default async function DiscoveryLeadDetailPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const actor = await resolveRequestActor();
  const result = await getLead(actor, leadId);

  if (!result.ok && result.code === "not_found") notFound();

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Lead." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const readiness = await getLeadReadiness(actor, leadId);
  const notesMeetingsPermissions = await computeNotesMeetingsUiPermissions(actor, "DISCOVERY_LEAD");

  return (
    <AppShell>
      <DiscoveryLeadDetail initialLead={result.data} initialReadiness={readiness.ok ? readiness.data : null} notesMeetingsPermissions={notesMeetingsPermissions} />
    </AppShell>
  );
}
