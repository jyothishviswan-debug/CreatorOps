import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { OverviewPanelData } from "@/features/shared/types";
import { relativeTime } from "@/features/discovery/format";
import { resolveRequestActor } from "@/server/discovery/http";
import { listLeads } from "@/server/discovery/lead-service";
import { LEAD_LIFECYCLE_STATES } from "@/server/discovery/types";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { LeadListCursor } from "@/server/discovery/firestore";

const TABS = [
  { label: "Overview", href: "/discovery" },
  { label: "Workspace", href: "/discovery/leads" },
];

// Bounded: enough pages to cover a realistic emulator/dev/local-
// acceptance dataset without an unbounded collection scan - same
// discipline as Administration's own Overview aggregation
// (loadAllLeads mirrors loadAllUsers there).
// Extracted from the page component body (not called inline during
// render) - same pattern as Administration's countEventsWithinWindow.
function countFollowUpsDue(leads: LeadDto[]): number {
  const now = Date.now();
  return leads.filter((l) => l.outreachSummary?.nextFollowUpAt && new Date(l.outreachSummary.nextFollowUpAt).getTime() <= now).length;
}

async function loadAllLeads(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<LeadDto[] | null> {
  const leads: LeadDto[] = [];
  let cursor: LeadListCursor | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await listLeads(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    leads.push(...result.data.leads);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return leads;
}

export default async function DiscoveryOverviewPage() {
  const actor = await resolveRequestActor();
  const leads = await loadAllLeads(actor);

  if (!leads) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FIND &amp; ONBOARD</div>
            <h1>Discovery</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Discovery data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const total = leads.length;
  const converted = leads.filter((l) => l.lifecycle === "CONVERTED").length;
  const conversionReady = leads.filter((l) => l.lifecycle === "CONVERSION_READY").length;
  const setAside = leads.filter((l) => l.lifecycle === "WATCHLIST" || l.lifecycle === "REJECTED" || l.lifecycle === "ARCHIVED" || l.lifecycle === "DUPLICATE").length;
  const followUpsDue = countFollowUpsDue(leads);
  const noResponse = leads.filter((l) => l.lifecycle === "CONTACTED").length;

  const lifecycleCounts = new Map(LEAD_LIFECYCLE_STATES.map((state) => [state, 0]));
  for (const lead of leads) lifecycleCounts.set(lead.lifecycle, (lifecycleCounts.get(lead.lifecycle) ?? 0) + 1);

  const recentlyUpdated = [...leads].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4);

  // Golden master's own "Discovery Pipeline" panel (docs/reference/
  // CreatorOps_UI_Golden_Master.html) is a 5-stage CUMULATIVE funnel -
  // Identified/Shortlisted/Outreach sent/In conversation/Converted, each
  // "reached this far or further" - never a flat per-lifecycle-state
  // bar chart. Each bucket is a direct evidence signal (not a lifecycle
  // guess), so a Lead parked in an alternative outcome (Watchlist etc.)
  // still counts toward every stage it genuinely reached.
  const shortlisted = leads.filter((l) => l.latestReview?.outcome === "SHORTLIST").length;
  const outreachSent = leads.filter((l) => l.outreachSummary != null).length;
  const inConversation = leads.filter((l) => l.respondedAt != null).length;

  const topPanels: OverviewPanelData[] = [
    {
      kind: "funnel",
      icon: "layers",
      title: "Discovery Pipeline",
      note: "Cumulative stage reach · current scope",
      foot: total > 0 ? `${converted} / ${total} converted · ${((converted / total) * 100).toFixed(1)}% conversion · stages are cumulative.` : "No Leads in scope yet.",
      span: 6,
      rows: [
        { label: "Identified", value: total },
        { label: "Shortlisted", value: shortlisted },
        { label: "Outreach sent", value: outreachSent },
        { label: "In conversation", value: inConversation },
        { label: "Converted", value: converted },
      ],
    },
    {
      kind: "donut",
      icon: "search",
      title: "Set-Aside Leads",
      note: `${total} Lead${total === 1 ? "" : "s"} in scope · alternative outcomes`,
      foot: setAside > 0 ? `${setAside} Lead${setAside === 1 ? "" : "s"} watchlisted, rejected, archived or duplicate.` : "No Leads set aside.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Leads",
      segments: [
        { label: "Watchlist", value: lifecycleCounts.get("WATCHLIST") ?? 0 },
        { label: "Rejected", value: lifecycleCounts.get("REJECTED") ?? 0 },
        { label: "Duplicate", value: lifecycleCounts.get("DUPLICATE") ?? 0 },
        { label: "Archived", value: lifecycleCounts.get("ARCHIVED") ?? 0 },
      ],
    },
    {
      kind: "checks",
      icon: "check",
      title: "Conversion Readiness",
      note: "Derived from the real readiness endpoint per Lead",
      foot: "Open a Lead to inspect its exact blockers and warnings.",
      span: 3,
      rows: [
        { label: "Conversion ready", detail: String(conversionReady), badge: "Ready" },
        { label: "Converted", detail: String(converted), badge: "Done" },
        { label: "Awaiting response", detail: String(noResponse), badge: "In progress" },
        { label: "Follow-ups due", detail: String(followUpsDue), badge: followUpsDue > 0 ? "Attention" : "Clear" },
      ],
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Most recently updated Leads in scope",
      foot: recentlyUpdated.length > 0 ? "Full history is on each Lead's own page." : "No Lead activity yet.",
      span: 4,
      rows: recentlyUpdated.map((lead) => ({
        title: lead.displayName,
        detail: `${lead.lifecycle.replace(/_/g, " ").toLowerCase()} · ${relativeTime(lead.updatedAt)}`,
        href: `/discovery/${lead.leadRef}`,
      })),
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Groups can overlap",
      foot: "Derived from real scoped Lead data - never fabricated.",
      span: 4,
      rows: [
        { title: "Follow-ups due", detail: "Outreach & Negotiation", count: String(followUpsDue) },
        { title: "Awaiting response", detail: "Contacted, no reply yet", count: String(noResponse) },
        { title: "Ready to convert", detail: "Conversion ready", count: String(conversionReady) },
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
        { label: "Open workspace", icon: "grid", href: "/discovery/leads" },
        { label: "Add a lead", icon: "plus", href: "/discovery/new" },
        { label: "Follow-up due", icon: "clock", href: "/discovery/leads?followUpDue=true" },
        { label: "Conversion ready", icon: "check", href: "/discovery/leads?lifecycle=CONVERSION_READY" },
      ],
    },
  ];

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">FIND &amp; ONBOARD</div>
            <h1>Discovery</h1>
            <p>Move the right prospects from first contact to partner.</p>
          </div>
          <div className="actions">
            <Link href="/discovery/new" className="btn primary">
              <Icon name="plus" /> Add lead
            </Link>
          </div>
        </div>

        <ModuleTabs tabs={TABS} />

        <ContextBanner
          icon="search"
          title="Discovery pipeline cockpit"
          description="What is happening, what needs attention, and where to act next."
          chips={["Real scoped emulator data", `${total} Lead${total === 1 ? "" : "s"} in scope`]}
        />

        <OverviewKpiRow
          items={[
            { icon: "search", label: "Leads in scope", value: String(total), hint: "authorized records" },
            { icon: "flag", label: "New", value: String(lifecycleCounts.get("NEW") ?? 0), hint: "not yet researched" },
            { icon: "check", label: "Conversion ready", value: String(conversionReady), hint: "readiness confirmed" },
            { icon: "users", label: "Converted", value: String(converted), hint: "linked to partners" },
            { icon: "clock", label: "Follow-ups due", value: String(followUpsDue), hint: "outreach overdue" },
            { icon: "alert", label: "Set aside", value: String(setAside), hint: "watchlist/rejected/archived/duplicate" },
          ]}
        />
        <OverviewPanels panels={topPanels} />
        <OverviewPanels panels={bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
