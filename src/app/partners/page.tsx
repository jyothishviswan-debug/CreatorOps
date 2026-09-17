import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { OverviewPanelData } from "@/features/shared/types";
import { relativeTime } from "@/features/partners/format";
import type { PartnerDto } from "@/server/partners/client-dto";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountDocSchema } from "@/server/partners/types";
import { resolveRequestActor } from "@/server/partners/http";
import { listPartners } from "@/server/partners/partner-service";
import { PARTNERS_COLLECTIONS, type PartnerListCursor } from "@/server/partners/firestore";
import { Filter } from "firebase-admin/firestore";

const TABS = [
  { label: "Overview", href: "/partners" },
  { label: "Workspace", href: "/partners/workspace" },
];

// Bounded: enough pages to cover a realistic emulator/dev/local-
// acceptance dataset without an unbounded collection scan - same
// discipline as Discovery's own loadAllLeads.
async function loadAllPartners(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<PartnerDto[] | null> {
  const partners: PartnerDto[] = [];
  let cursor: PartnerListCursor | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await listPartners(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    partners.push(...result.data.partners);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return partners;
}

// Bounded platform-account aggregate for the already-loaded, already
// scope-checked partnerRefs (never an unbounded/cross-scope collection
// scan) - Firestore's `in` operator caps at 30 values per query, so this
// batches into chunks of 30 (at most 10 queries for the 300-partner cap
// above). Powers the golden master's "Platform Footprint"/"Account
// Distribution" panels and the "Platform accounts" KPI, none of which
// have any other real data source today.
async function loadAccountCountsByPartner(partnerRefs: string[]): Promise<{ totalAccounts: number; byPlatform: Map<string, number>; byPartnerRef: Map<string, number> }> {
  const db = getAdminFirestore();
  const collection = db.collection(PARTNERS_COLLECTIONS.partnerAccounts);
  const byPlatform = new Map<string, number>();
  const byPartnerRef = new Map<string, number>();
  let totalAccounts = 0;

  for (let i = 0; i < partnerRefs.length; i += 30) {
    const chunk = partnerRefs.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const snapshot = await collection.where(Filter.where("partnerRef", "in", chunk)).get();
    for (const doc of snapshot.docs) {
      const parsed = partnerAccountDocSchema.safeParse(doc.data());
      if (!parsed.success) continue;
      totalAccounts += 1;
      byPlatform.set(parsed.data.platform, (byPlatform.get(parsed.data.platform) ?? 0) + 1);
      byPartnerRef.set(parsed.data.partnerRef, (byPartnerRef.get(parsed.data.partnerRef) ?? 0) + 1);
    }
  }

  return { totalAccounts, byPlatform, byPartnerRef };
}

export default async function PartnersOverviewPage() {
  const actor = await resolveRequestActor();
  const partners = await loadAllPartners(actor);

  if (!partners) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FIND &amp; ONBOARD</div>
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
  const active = partners.filter((p) => p.status === "ACTIVE").length;
  const blacklisted = partners.filter((p) => p.status === "BLACKLISTED").length;
  const activePct = total > 0 ? ((active / total) * 100).toFixed(1) : "0.0";

  const { totalAccounts, byPlatform, byPartnerRef } = await loadAccountCountsByPartner(partners.map((p) => p.partnerRef));

  // "Profile complete" has no single canonical field - defined here as
  // the same safe-contact + region completeness a real operator would
  // check before treating a Partner as ready to work with (documented,
  // not a hidden guess).
  const profileComplete = partners.filter((p) => p.email && p.phone && p.regionIds.length > 0).length;
  const ownerAssigned = partners.filter((p) => p.ownerRef).length;
  const platformLinked = partners.filter((p) => (byPartnerRef.get(p.partnerRef) ?? 0) > 0).length;
  const noPlatformAccount = partners.filter((p) => (byPartnerRef.get(p.partnerRef) ?? 0) === 0).length;
  const incompleteProfile = partners.filter((p) => !p.email || !p.phone).length;
  const noOwnerAssigned = partners.filter((p) => !p.ownerRef).length;

  // "Needs attention" KPI - a deduplicated union, never a sum of
  // overlapping groups (a Partner can be both unowned and missing an
  // account).
  const needsAttentionRefs = new Set(
    partners.filter((p) => (byPartnerRef.get(p.partnerRef) ?? 0) === 0 || !p.email || !p.phone || !p.ownerRef || p.status === "BLACKLISTED").map((p) => p.partnerRef),
  );

  let multiPlatform = 0;
  let singlePlatform = 0;
  let noAccount = 0;
  for (const partner of partners) {
    const count = byPartnerRef.get(partner.partnerRef) ?? 0;
    if (count === 0) noAccount += 1;
    else if (count === 1) singlePlatform += 1;
    else multiPlatform += 1;
  }

  const platformRows = [...byPlatform.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const regionCounts = new Map<string, number>();
  for (const partner of partners) {
    for (const region of partner.regionIds.length > 0 ? partner.regionIds : ["Unassigned"]) {
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    }
  }
  const topRegions = [...regionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const recentlyUpdated = [...partners].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4);

  // Mirrors the golden master's own "creators" module exactly: 5 KPIs,
  // 4 top panels (Creator Status/Platform Footprint/Account Distribution/
  // Creator Health), 4 bottom panels (Top Regions/Exceptions/Recent
  // Activity/Quick Actions) - see docs/reference/CreatorOps_UI_Golden_Master.html.
  // "Campaign active" has no real data source yet (no Campaigns<->Partners
  // link exists) - shown as an honest "not yet available", never a
  // fabricated number.
  const topPanels: OverviewPanelData[] = [
    {
      kind: "donut",
      icon: "users",
      title: "Partner Status",
      note: `${total} canonical partner${total === 1 ? "" : "s"}`,
      foot: total > 0 ? `${activePct}% of the roster is active.` : "No Partners in scope yet.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Partners",
      segments: [
        { label: "Active", value: active },
        { label: "Inactive", value: partners.filter((p) => p.status === "INACTIVE").length },
        { label: "Blacklisted", value: blacklisted },
      ],
    },
    {
      kind: "donut",
      icon: "link",
      title: "Platform Footprint",
      note: "Partners by account coverage",
      foot: `${platformLinked} partner${platformLinked === 1 ? "" : "s"} have accounts · ${totalAccounts} linked accounts.`,
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Partners",
      segments: [
        { label: "Multi-platform", value: multiPlatform },
        { label: "Single platform", value: singlePlatform },
        { label: "No account", value: noAccount },
      ],
    },
    {
      kind: "columns",
      icon: "layers",
      title: "Account Distribution",
      note: `${totalAccounts} linked platform account${totalAccounts === 1 ? "" : "s"}`,
      foot: "Counts represent accounts, not unique partners.",
      span: 3,
      rows: platformRows.map(([label, value]) => ({ label, value })),
    },
    {
      kind: "checks",
      icon: "check",
      title: "Partner Health",
      note: "Independent readiness dimensions",
      foot: "Check readiness without exposing restricted identity data.",
      span: 3,
      rows: [
        { label: "Owner assigned", detail: `${ownerAssigned} / ${total}`, badge: "Coverage" },
        { label: "Profile complete", detail: `${profileComplete} / ${total}`, badge: "Coverage" },
        { label: "Platform linked", detail: `${platformLinked} / ${total}`, badge: "Coverage" },
        { label: "Campaign active", detail: "Not yet available", badge: "Review" },
      ],
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "rank",
      icon: "flag",
      title: "Top Regions",
      note: "Partners by assigned region",
      foot: `${total} partner${total === 1 ? "" : "s"} in scope.`,
      span: 3,
      rows: topRegions.map(([name, value]) => ({ name, value: String(value), initials: name.slice(0, 2).toUpperCase() })),
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Exceptions",
      note: "Groups can overlap",
      foot: "Sensitive details remain in authorized record views.",
      span: 3,
      rows: [
        { title: "No platform account", detail: "Link a real account", count: String(noPlatformAccount) },
        { title: "Incomplete profile", detail: "Missing email or phone", count: String(incompleteProfile) },
        { title: "No owner assigned", detail: "Assign an owner", count: String(noOwnerAssigned) },
        { title: "Blacklisted partners", detail: "Governance review", count: String(blacklisted) },
      ],
    },
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Most recently updated Partners in scope",
      foot: recentlyUpdated.length > 0 ? "Full history is on each Partner's own page." : "No Partner activity yet.",
      span: 3,
      rows: recentlyUpdated.map((partner) => ({
        title: partner.displayName,
        detail: `${partner.status.toLowerCase()} · ${relativeTime(partner.updatedAt)}`,
        href: `/partners/${partner.partnerRef}`,
      })),
    },
    {
      kind: "actions",
      icon: "grid",
      title: "Quick Actions",
      note: "Continue from insight to action",
      foot: "Every action below navigates to a real screen.",
      span: 3,
      rows: [
        { label: "Partner workspace", icon: "grid", href: "/partners/workspace" },
        { label: "Add a partner", icon: "plus", href: "/partners/new" },
        { label: "Setup pending", icon: "link", href: "/partners/workspace" },
        { label: "Open workspace", icon: "grid", href: "/partners/workspace" },
      ],
    },
  ];

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">FIND &amp; ONBOARD</div>
            <h1>Partners</h1>
            <p>Understand roster health, account coverage and readiness.</p>
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
          title="Partner portfolio intelligence"
          description="What is happening, what needs attention, and where to act next."
          chips={["Real scoped emulator data", `${total} Partner${total === 1 ? "" : "s"} in scope`]}
        />

        <OverviewKpiRow
          items={[
            { icon: "users", label: "Total partners", value: String(total), hint: "canonical identities" },
            { icon: "check", label: "Active partners", value: String(active), hint: `${activePct}% of roster` },
            { icon: "link", label: "Platform accounts", value: String(totalAccounts), hint: "linked channels" },
            { icon: "flag", label: "Campaign active", value: "—", hint: "not yet available" },
            { icon: "alert", label: "Needs attention", value: String(needsAttentionRefs.size), hint: "unique partners" },
          ]}
        />
        <OverviewPanels panels={topPanels} />
        <OverviewPanels panels={bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
