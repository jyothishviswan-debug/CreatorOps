import Link from "next/link";
import { Filter } from "firebase-admin/firestore";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import type { OverviewPanelData } from "@/features/shared/types";
import { VendorsHome } from "@/features/vendors/VendorsHome";
import { relativeTime } from "@/features/vendors/format";
import type { VendorDto } from "@/server/vendors/client-dto";
import { getAdminFirestore } from "@/server/firebase/admin";
import { vendorPartnerLinkDocSchema } from "@/server/vendors/types";
import { resolveRequestActor } from "@/server/vendors/http";
import { listVendors } from "@/server/vendors/vendor-service";
import { VENDORS_COLLECTIONS, type VendorListCursor } from "@/server/vendors/firestore";

// Bounded: enough pages to cover a realistic emulator/dev/local-
// acceptance dataset without an unbounded collection scan - same
// discipline as Partners' own loadAllPartners/Discovery's loadAllLeads.
async function loadAllVendors(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<VendorDto[] | null> {
  const vendors: VendorDto[] = [];
  let cursor: VendorListCursor | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await listVendors(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    vendors.push(...result.data.vendors);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return vendors;
}

// Bounded relationship aggregate for the already-loaded, already scope-
// checked vendorRefs (never an unbounded/cross-scope collection scan) -
// Firestore's `in` operator caps at 30 values per query, so this batches
// into chunks of 30, same idiom as Partners' own loadAccountCountsByPartner.
async function loadRelationshipCountsByVendor(vendorRefs: string[]): Promise<{ activeByVendorRef: Map<string, number>; totalActiveLinks: number; ended: number }> {
  const db = getAdminFirestore();
  const collection = db.collection(VENDORS_COLLECTIONS.vendorPartnerLinks);
  const activeByVendorRef = new Map<string, number>();
  let totalActiveLinks = 0;
  let ended = 0;

  for (let i = 0; i < vendorRefs.length; i += 30) {
    const chunk = vendorRefs.slice(i, i + 30);
    if (chunk.length === 0) continue;
    const snapshot = await collection.where(Filter.where("vendorRef", "in", chunk)).get();
    for (const doc of snapshot.docs) {
      const parsed = vendorPartnerLinkDocSchema.safeParse(doc.data());
      if (!parsed.success) continue;
      if (parsed.data.status === "ACTIVE") {
        activeByVendorRef.set(parsed.data.vendorRef, (activeByVendorRef.get(parsed.data.vendorRef) ?? 0) + 1);
        totalActiveLinks += 1;
      } else {
        ended += 1;
      }
    }
  }

  return { activeByVendorRef, totalActiveLinks, ended };
}

export default async function VendorsOverviewPage() {
  const actor = await resolveRequestActor();
  const vendors = await loadAllVendors(actor);

  if (!vendors) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">FIND &amp; ONBOARD</div>
            <h1>Vendors</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Vendors data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const total = vendors.length;
  const active = vendors.filter((v) => v.status === "ACTIVE").length;
  const inactive = vendors.filter((v) => v.status === "INACTIVE").length;
  const archived = vendors.filter((v) => v.status === "ARCHIVED").length;
  const activePct = total > 0 ? ((active / total) * 100).toFixed(1) : "0.0";

  const { activeByVendorRef, totalActiveLinks, ended } = await loadRelationshipCountsByVendor(vendors.map((v) => v.vendorRef));
  const withActiveRelationship = vendors.filter((v) => (activeByVendorRef.get(v.vendorRef) ?? 0) > 0).length;
  const noActiveRelationship = total - withActiveRelationship;

  const ownerAssigned = vendors.filter((v) => v.ownerRef).length;
  const noOwnerAssigned = total - ownerAssigned;
  const profileComplete = vendors.filter((v) => v.email && v.phone && v.regionIds.length > 0).length;
  const incompleteProfile = total - profileComplete;

  const needsAttentionRefs = new Set(vendors.filter((v) => !v.ownerRef || !v.email || !v.phone || (activeByVendorRef.get(v.vendorRef) ?? 0) === 0).map((v) => v.vendorRef));

  const typeCounts = new Map<string, number>();
  for (const vendor of vendors) typeCounts.set(vendor.vendorType, (typeCounts.get(vendor.vendorType) ?? 0) + 1);

  const regionCounts = new Map<string, number>();
  for (const vendor of vendors) {
    for (const region of vendor.regionIds.length > 0 ? vendor.regionIds : ["Unassigned"]) {
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    }
  }
  const topRegions = [...regionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const recentlyUpdated = [...vendors].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4);

  const typeLabels: Record<string, string> = {
    AGENCY: "Agency",
    MANAGEMENT_COMPANY: "Management company",
    MANAGER_REPRESENTATIVE: "Manager / representative",
    PAYEE_BUSINESS: "Payee business",
    OTHER: "Other",
  };

  // Mirrors the same real-data-only discipline as Partners' Overview:
  // every number here is derived from the actual scoped, loaded Vendor
  // set (bounded to 3 pages / 300 records) - never fabricated. Campaign
  // involvement has no real data source yet (no Campaigns<->Vendors link
  // exists), shown as an honest "not yet available", never a fabricated
  // number.
  const topPanels: OverviewPanelData[] = [
    {
      kind: "donut",
      icon: "brief",
      title: "Vendor Status",
      note: `${total} canonical vendor${total === 1 ? "" : "s"}`,
      foot: total > 0 ? `${activePct}% of vendors are active.` : "No Vendors in scope yet.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Vendors",
      segments: [
        { label: "Active", value: active },
        { label: "Inactive", value: inactive },
        { label: "Archived", value: archived },
      ],
    },
    {
      kind: "donut",
      icon: "users",
      title: "Vendor Type",
      note: `${total} vendor record${total === 1 ? "" : "s"}`,
      foot: "Representation and Partner identity stay separate.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Vendors",
      segments: [...typeCounts.entries()].map(([type, value]) => ({ label: typeLabels[type] ?? type, value })),
    },
    {
      kind: "columns",
      icon: "layers",
      title: "Regional Composition",
      note: `${total} vendor${total === 1 ? "" : "s"} by region`,
      foot: "Counts represent vendors, bounded to the current loaded scope.",
      span: 3,
      rows: topRegions.map(([label, value]) => ({ label, value })),
    },
    {
      kind: "checks",
      icon: "check",
      title: "Vendor Health",
      note: "Independent readiness dimensions",
      foot: "Check readiness without exposing restricted identity data.",
      span: 3,
      rows: [
        { label: "Owner assigned", detail: `${ownerAssigned} / ${total}`, badge: "Coverage" },
        { label: "Profile complete", detail: `${profileComplete} / ${total}`, badge: "Coverage" },
        { label: "Has active relationship", detail: `${withActiveRelationship} / ${total}`, badge: "Coverage" },
        { label: "Active relationships (total)", detail: String(totalActiveLinks), badge: "Current" },
      ],
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "rank",
      icon: "flag",
      title: "Top Regions",
      note: "Vendors by assigned region",
      foot: `${total} vendor${total === 1 ? "" : "s"} in scope.`,
      span: 3,
      rows: topRegions.map(([name, value]) => ({ name, value: String(value), initials: name.slice(0, 2).toUpperCase() })),
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Needs Attention",
      note: "Groups can overlap",
      foot: "Sensitive details remain in authorized record views.",
      span: 3,
      rows: [
        { title: "No active Partner relationship", detail: "Link a Partner", count: String(noActiveRelationship) },
        { title: "Incomplete profile", detail: "Missing email, phone or region", count: String(incompleteProfile) },
        { title: "No owner assigned", detail: "Assign an owner", count: String(noOwnerAssigned) },
        { title: "Ended relationships on file", detail: "Historical", count: String(ended) },
      ],
    },
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Most recently updated Vendors in scope",
      foot: recentlyUpdated.length > 0 ? "Full history is on each Vendor's own page." : "No Vendor activity yet.",
      span: 3,
      rows: recentlyUpdated.map((vendor) => ({
        title: vendor.displayName,
        detail: `${vendor.status.toLowerCase()} · ${relativeTime(vendor.updatedAt)}`,
        href: `/vendors/${vendor.vendorRef}`,
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
        { label: "Vendor workspace", icon: "grid" },
        { label: "Add a vendor", icon: "plus", href: "/vendors/new" },
        { label: "Review relationships", icon: "link" },
        { label: "Needs attention", icon: "alert" },
      ],
    },
  ];

  const initial = await listVendors(actor, { limit: 10 });
  const initialVendors = initial.ok ? initial.data.vendors : [];
  const initialNextCursor = initial.ok ? initial.data.nextCursor : null;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">FIND &amp; ONBOARD</div>
          <h1>Vendors</h1>
          <p>Agency, manager, representative and payee relationships associated with your Partners.</p>
        </div>
        <div className="actions">
          <Link href="/vendors/new" className="btn primary">
            + Add vendor
          </Link>
        </div>
      </div>

      <VendorsHome
        kpis={[
          { icon: "brief", label: "Total vendors", value: String(total), hint: "canonical identities" },
          { icon: "check", label: "Active vendors", value: String(active), hint: `${activePct}% of roster` },
          { icon: "link", label: "Active relationships", value: String(withActiveRelationship), hint: "vendors with a Partner link" },
          { icon: "flag", label: "Campaign engaged", value: "—", hint: "not yet available" },
          { icon: "alert", label: "Needs attention", value: String(needsAttentionRefs.size), hint: "unique vendors" },
        ]}
        topPanels={topPanels}
        bottomPanels={bottomPanels}
        summary="What is happening, what needs attention, and where to act next."
        chips={["Real scoped emulator data", `${total} Vendor${total === 1 ? "" : "s"} in scope`]}
        initialVendors={initialVendors}
        initialNextCursor={initialNextCursor}
      />
    </AppShell>
  );
}
