import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { DiscoveryLeadForm } from "@/features/discovery/DiscoveryLeadForm";

export default function NewDiscoveryLeadPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">DISCOVERY / NEW LEAD</div>
          <h1>Create a lead</h1>
          <p>Start with the essentials. Add supporting context where it helps.</p>
        </div>
        <div className="actions">
          <Link href="/discovery/leads" className="btn">
            Back to workspace
          </Link>
        </div>
      </div>

      <DiscoveryLeadForm mode="create" />
    </AppShell>
  );
}
