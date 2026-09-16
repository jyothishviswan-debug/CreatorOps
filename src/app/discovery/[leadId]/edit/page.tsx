import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { DiscoveryLeadForm } from "@/features/discovery/DiscoveryLeadForm";
import { resolveRequestActor } from "@/server/discovery/http";
import { getLead } from "@/server/discovery/lead-service";

export default async function EditDiscoveryLeadPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const actor = await resolveRequestActor();
  const result = await getLead(actor, leadId);

  if (!result.ok && result.code === "not_found") notFound();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">DISCOVERY / EDIT LEAD</div>
          <h1>{result.ok ? `Edit ${result.data.displayName}` : "Edit lead"}</h1>
          <p>Ordinary fields only - evidence is recorded from the Lead&rsquo;s own workflow rail.</p>
        </div>
        <div className="actions">
          <Link href={result.ok ? `/discovery/${leadId}` : "/discovery/leads"} className="btn">
            Back
          </Link>
        </div>
      </div>

      {result.ok ? (
        <DiscoveryLeadForm mode="edit" lead={result.data} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to edit this Lead." icon="lock" />
        </section>
      )}
    </AppShell>
  );
}
