import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { PartnerForm } from "@/features/partners/PartnerForm";

export default function NewPartnerPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PARTNERS / NEW PARTNER</div>
          <h1>Add a partner</h1>
          <p>Start with the essentials. Add supporting context where it helps.</p>
        </div>
        <div className="actions">
          <Link href="/partners/workspace" className="btn">
            Back to workspace
          </Link>
        </div>
      </div>

      <PartnerForm mode="create" />
    </AppShell>
  );
}
