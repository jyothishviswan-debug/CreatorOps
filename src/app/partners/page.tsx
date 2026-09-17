import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { OverviewPanelData } from "@/features/shared/types";
import { relativeTime } from "@/features/partners/format";
import type { PartnerDto } from "@/server/partners/client-dto";
import { resolveRequestActor } from "@/server/partners/http";
import { listPartners } from "@/server/partners/partner-service";
import { PARTNER_STATUSES } from "@/server/partners/types";

const TABS = [
  { label: "Overview", href: "/partners" },
  { label: "Workspace", href: "/partners/workspace" },
];

// Bounded: enough pages to cover a realistic emulator/dev/local-
// acceptance dataset without an unbounded collection scan - same
// discipline as Discovery's own loadAllLeads.
async function loadAllPartners(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<PartnerDto[] | null> {
  const partners: PartnerDto[] = [];
  let cursor: { orderValue: string; uid: string } | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await listPartners(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    partners.push(...result.data.partners);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return partners;
}

export default async function PartnersOverviewPage() {
  const actor = await resolveRequestActor();
  const partners = await loadAllPartners(actor);

  if (!partners) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">RELATIONSHIPS</div>
            <h1>Partners</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Partners data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const total = partners.length;
  const statusCounts = new Map(PARTNER_STATUSES.map((s) => [s, 0]));
  for (const partner of partners) statusCounts.set(partner.status, (statusCounts.get(partner.status) ?? 0) + 1);

  const pendingSetup = partners.filter((p) => p.pendingPartnerAccountSetup).length;
  const noOwner = partners.filter((p) => !p.ownerRef && p.status === "ACTIVE").length;
  const blacklisted = statusCounts.get("BLACKLISTED") ?? 0;
  const archived = statusCounts.get("ARCHIVED") ?? 0;

  const regionCounts = new Map<string, number>();
  for (const partner of partners) {
    const region = partner.regionIds[0] ?? "Unassigned";
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }
  const topRegions = [...regionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const recentlyUpdated = [...partners].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4);

  const topPanels: OverviewPanelData[] = [
    {
      kind: "donut",
      icon: "users",
      title: "Partner Status",
      note: `${total} Partner${total === 1 ? "" : "s"} in scope · current scope`,
      foot: total > 0 ? `${statusCounts.get("ACTIVE") ?? 0} active of ${total} in scope.` : "No Partners in scope yet.",
      span: 4,
      total: Math.max(total, 1),
      totalLabel: "Partners",
      segments: PARTNER_STATUSES.map((s) => ({ label: s.charAt(0) + s.slice(1).toLowerCase(), value: statusCounts.get(s) ?? 0 })),
    },
    {
      kind: "columns",
      icon: "layers",
      title: "Region Summary",
      note: "Primary region, bounded to loaded scope",
      foot: "Counts reflect only currently loaded scoped Partners, not a global total.",
      span: 4,
      rows: topRegions.map(([label, value]) => ({ label, value })),
    },
    {
      kind: "checks",
      icon: "alert",
      title: "Attention",
      note: "Derived from real scoped Partner data",
      foot: "Open the Workspace to filter directly on any of these.",
      span: 4,
      rows: [
        { label: "Account setup pending", detail: String(pendingSetup), badge: pendingSetup > 0 ? "Attention" : "Clear" },
        { label: "Active with no owner", detail: String(noOwner), badge: noOwner > 0 ? "Attention" : "Clear" },
        { label: "Blacklisted", detail: String(blacklisted), badge: blacklisted > 0 ? "Review" : "Clear" },
        { label: "Archived", detail: String(archived), badge: "Current" },
      ],
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Most recently updated Partners in scope",
      foot: recentlyUpdated.length > 0 ? "Full history is on each Partner's own page." : "No Partner activity yet.",
      span: 4,
      rows: recentlyUpdated.map((partner) => ({
        title: partner.displayName,
        detail: `${partner.status.toLowerCase()} · ${relativeTime(partner.updatedAt)}`,
        href: `/partners/${partner.partnerRef}`,
      })),
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Groups can overlap",
      foot: "Derived from real scoped Partner data - never fabricated.",
      span: 4,
      rows: [
        { title: "Account setup pending", detail: "Discovery-converted, no account yet", count: String(pendingSetup) },
        { title: "Active, unassigned", detail: "No owner on file", count: String(noOwner) },
        { title: "Blacklisted", detail: "Governance review", count: String(blacklisted) },
      ],
    },
    {
      kind: "actions",
      icon: "grid",
      title: "Quick Actions",
      note: "Continue from insight to action",
      foot: "Every action below navigates to a real screen.",
      span: 4,
      rows: [
        { label: "Open workspace", icon: "grid", href: "/partners/workspace" },
        { label: "Add a partner", icon: "plus", href: "/partners/new" },
        { label: "Setup pending", icon: "clock", href: "/partners/workspace" },
        { label: "Blacklisted", icon: "alert", href: "/partners/workspace" },
      ],
    },
  ];

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">RELATIONSHIPS</div>
            <h1>Partners</h1>
            <p>Canonical creator/influencer relationships and their platform accounts.</p>
          </div>
          <div className="actions">
            <Link href="/partners/new" className="btn primary">
              <Icon name="plus" /> Add partner
            </Link>
          </div>
        </div>

        <ModuleTabs tabs={TABS} />

        <ContextBanner
          icon="users"
          title="Partners cockpit"
          description="What is happening, what needs attention, and where to act next."
          chips={["Real scoped emulator data", `${total} Partner${total === 1 ? "" : "s"} in scope`]}
        />

        <OverviewKpiRow
          items={[
            { icon: "users", label: "Partners in scope", value: String(total), hint: "authorized records" },
            { icon: "check", label: "Active", value: String(statusCounts.get("ACTIVE") ?? 0), hint: "operational" },
            { icon: "clock", label: "Setup pending", value: String(pendingSetup), hint: "needs an account" },
            { icon: "alert", label: "No owner", value: String(noOwner), hint: "active, unassigned" },
            { icon: "shield", label: "Blacklisted", value: String(blacklisted), hint: "governance" },
            { icon: "file", label: "Archived", value: String(archived), hint: "wound down" },
          ]}
        />
        <OverviewPanels panels={topPanels} />
        <OverviewPanels panels={bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
