import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { PartnerForm } from "@/features/partners/PartnerForm";
import { resolveRequestActor } from "@/server/partners/http";
import { getPartner } from "@/server/partners/partner-service";

export default async function EditPartnerPage({ params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  const actor = await resolveRequestActor();
  const result = await getPartner(actor, partnerId);

  if (!result.ok && result.code === "not_found") notFound();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNERS / EDIT PARTNER</div>
          <h1>{result.ok ? `Edit ${result.data.displayName}` : "Edit partner"}</h1>
          <p>Ordinary fields only - owner/team, lifecycle and restricted identity are recorded from the Partner&rsquo;s own detail page.</p>
        </div>
        <div className="actions">
          <Link href={result.ok ? `/partners/${partnerId}` : "/partners/workspace"} className="btn">
            Back
          </Link>
        </div>
      </div>

      {result.ok ? (
        <PartnerForm mode="edit" partner={result.data} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to edit this Partner." icon="lock" />
        </section>
      )}
    </AppShell>
  );
}
