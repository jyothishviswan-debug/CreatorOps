import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { AdminUserDetail } from "@/features/administration/AdminUserDetail";
import { resolveRequestActor } from "@/server/administration/http";
import { getUser } from "@/server/administration/users-service";
import { getEffectiveAccess } from "@/server/administration/effective-access-service";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userRef: string }> }) {
  const { userRef } = await params;
  const actor = await resolveRequestActor();

  const userResult = await getUser(actor, userRef);
  if (!userResult.ok && userResult.code === "not_found") notFound();
  if (!userResult.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this record." />
        </section>
      </AppShell>
    );
  }

  const effectiveAccessResult = await getEffectiveAccess(actor, userRef);

  return (
    <AppShell>
      <AdminUserDetail initialUser={userResult.data} initialEffectiveAccess={effectiveAccessResult.ok ? effectiveAccessResult.data : null} />
    </AppShell>
  );
}
