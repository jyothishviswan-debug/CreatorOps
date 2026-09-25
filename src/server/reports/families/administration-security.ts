import type { ActorContext } from "@/server/authz/types";
import { listUsers } from "@/server/administration/users-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Administration & Security (section 4) - safe, label-only user/role summary. Sourced through
// Administration's own listUsers, which already limits this report to actors who hold real
// Administration FeatureAccess (see reports-gate.ts's requireSourceFeatureAccess) - Reports never
// widens who can see this data. Only the already-safe AdminUserDto fields are ever touched; no raw
// Firebase uid, session token, secret, or audit before/after payload is read here at all.
const PAGE_SIZE = 100;

export async function runAdministrationSecurityReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const statusFilter = appliedFilters.status;
  const active = statusFilter === "active" ? true : statusFilter === "inactive" ? false : undefined;

  const usersResult = await listUsers(actor, { limit: PAGE_SIZE, active });
  if (!usersResult.ok) return mapSourceError(usersResult);

  const users = usersResult.data.users;
  const activeUserCount = users.filter((u) => u.active).length;
  const byRole: Record<string, number> = {};
  for (const user of users) byRole[user.role] = (byRole[user.role] ?? 0) + 1;

  const rows: ReportRow[] = users.map((u) => ({ userRef: u.userRef, role: u.role, active: u.active, displayName: u.displayName }));

  return {
    ok: true,
    data: buildReportResult({
      reportId: "administration_security",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listUsers, Administration FeatureAccess required)", note: "Every user row the acting Administration-privileged actor may already see." },
      metrics: { userCount: users.length, activeUserCount, byRoleCount: Object.keys(byRole).length },
      rows,
      sections: { byRole },
      truncated: usersResult.data.nextCursor !== null,
      rowCount: rows.length,
      provenance: [{ sourceModule: "administration", sourceFunction: "listUsers", recordCount: users.length }],
    }),
  };
}
