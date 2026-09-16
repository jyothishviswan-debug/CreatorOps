import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { EmptyState } from "@/ui/States";
import type { OverviewPanelData } from "@/features/shared/types";
import { operationLabel, relativeTime } from "@/features/administration/format";
import { resolveRequestActor } from "@/server/administration/http";
import { listUsers } from "@/server/administration/users-service";
import { listAuditEventsForReview } from "@/server/administration/audit-service";
import { ROLES, ROLE_LABELS } from "@/server/authz/roles";
import type { Role } from "@/server/authz/roles";
import type { AdminUserDto } from "@/server/administration/types";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

// Bounded: enough pages to cover a realistic emulator/dev dataset (up to
// 500 users) without an unbounded collection scan.
async function loadAllUsers(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<AdminUserDto[] | null> {
  const users: AdminUserDto[] = [];
  let cursor: { email: string; userRef: string } | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await listUsers(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    users.push(...result.data.users);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return users;
}

function countEventsWithinWindow(events: { createdAt: string }[], windowMs: number): number {
  const now = Date.now();
  return events.filter((event) => now - new Date(event.createdAt).getTime() < windowMs).length;
}

export default async function AdministrationOverviewPage() {
  const actor = await resolveRequestActor();
  const [users, auditPage] = await Promise.all([loadAllUsers(actor), listAuditEventsForReview(actor, { limit: 20 })]);

  if (!users || !auditPage.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">SYSTEM GOVERNANCE</div>
            <h1>Administration</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Administration governance data." />
        </section>
      </AppShell>
    );
  }

  const total = users.length;
  const active = users.filter((user) => user.active).length;
  const inactive = total - active;
  const activeSuperAdmins = users.filter((user) => user.role === "super_admin" && user.active).length;

  const roleCounts = new Map<Role, number>(ROLES.map((role) => [role, 0]));
  for (const user of users) roleCounts.set(user.role, (roleCounts.get(user.role) ?? 0) + 1);

  const recentEvents = auditPage.data.events;
  const changesLast24h = countEventsWithinWindow(recentEvents, 24 * 60 * 60 * 1000);

  const topPanels: OverviewPanelData[] = [
    {
      kind: "donut",
      icon: "users",
      title: "Users by Role",
      note: `${total} user${total === 1 ? "" : "s"} · five canonical roles`,
      foot: "Access combines capability, scope and field sensitivity.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Users",
      segments: ROLES.map((role) => ({ label: ROLE_LABELS[role], value: roleCounts.get(role) ?? 0 })),
    },
    {
      kind: "donut",
      icon: "check",
      title: "User Status",
      note: `${total} directory profile${total === 1 ? "" : "s"}`,
      foot: total > 0 ? `${Math.round((active / total) * 100)}% of users are active.` : "No users yet.",
      span: 3,
      total: Math.max(total, 1),
      totalLabel: "Accounts",
      segments: [
        { label: "Active", value: active },
        { label: "Inactive", value: inactive },
      ],
    },
    {
      kind: "checks",
      icon: "shield",
      title: "Access Governance",
      note: "Account and scope safeguards",
      foot: "Roles are non-monotonic; access is never UI-only.",
      span: 3,
      rows: [
        { label: "Admin resilience", detail: `${activeSuperAdmins} active Super Admin${activeSuperAdmins === 1 ? "" : "s"}`, badge: activeSuperAdmins <= 1 ? "Protected" : "Healthy" },
        { label: "Active admission", detail: `${active} of ${total} users active`, badge: "Live" },
        { label: "Enforcement boundary", detail: "Every mutation re-verified server-side", badge: "Guarded" },
        { label: "Scope requirement", detail: "GLOBAL scope required, never inferred", badge: "Explicit" },
      ],
    },
    {
      kind: "checks",
      icon: "layers",
      title: "Role Distribution",
      note: "Live counts per canonical role",
      foot: "Roles are a closed set - never ranked or inferred.",
      span: 3,
      rows: ROLES.map((role) => {
        const count = roleCounts.get(role) ?? 0;
        return { label: ROLE_LABELS[role], detail: `${count} user${count === 1 ? "" : "s"}`, badge: count > 0 ? "Assigned" : "Unassigned" };
      }),
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Latest access-changing mutations",
      foot: recentEvents.length > 0 ? "Full history stays in the audit workspace." : "No access-changing mutations recorded yet.",
      span: 6,
      rows: recentEvents.slice(0, 5).map((event) => ({
        title: operationLabel(event.operation),
        detail: `${event.actorEmail} · ${relativeTime(event.createdAt)}`,
        href: "/administration/audit",
      })),
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Pending Actions",
      note: "Actionable directory queues",
      foot: "Derived from the live emulator dataset.",
      span: 6,
      rows: [
        { title: "Inactive users", detail: "Review admission", count: String(inactive) },
        { title: "Access changes (24h)", detail: "Audit trail", count: String(changesLast24h) },
      ],
    },
  ];

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Administration</h1>
          <p>Understand access, scope integrity and system capability.</p>
        </div>
      </div>

      <ModuleTabs tabs={TABS} />

      <ContextBanner
        icon="shield"
        title="Administration governance cockpit"
        description="What is happening, what needs attention, and where to act next."
        chips={["Live emulator data", `${total} user${total === 1 ? "" : "s"}`]}
      />

      <OverviewKpiRow
        items={[
          { icon: "users", label: "Total users", value: String(total), hint: "registered accounts" },
          { icon: "check", label: "Active users", value: String(active), hint: "admitted users" },
          { icon: "alert", label: "Inactive users", value: String(inactive), hint: "not admitted" },
          { icon: "shield", label: "Configured roles", value: String(ROLES.length), hint: "non-monotonic access" },
          { icon: "lock", label: "Active Super Admins", value: String(activeSuperAdmins), hint: "protected by last-admin guard" },
          { icon: "clock", label: "Access changes (24h)", value: String(changesLast24h), hint: "from the audit trail" },
        ]}
      />
      <OverviewPanels panels={topPanels} />
      <OverviewPanels panels={bottomPanels} secondary />
    </AppShell>
  );
}
