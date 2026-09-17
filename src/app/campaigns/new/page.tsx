import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { CampaignForm } from "@/features/campaigns/CampaignForm";

export default function NewCampaignPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">CAMPAIGNS / NEW CAMPAIGN</div>
          <h1>Create a campaign</h1>
          <p>Start with the essentials. Resources and lifecycle are managed afterward.</p>
        </div>
        <div className="actions">
          <Link href="/campaigns" className="btn">
            Back to campaigns
          </Link>
        </div>
      </div>

      <CampaignForm />
    </AppShell>
  );
}
