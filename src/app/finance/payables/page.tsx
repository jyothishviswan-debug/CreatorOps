import Link from "next/link";

import { FinancePageShell } from "@/features/finance/FinancePageShell";
import { NEW_PAYABLE_HREF, parseWorkspaceUrlState, PayablesWorkspace, toWorkspaceRequest, WORKSPACE_SUBTITLE, WORKSPACE_TITLE, WorkspaceDenied, WorkspaceLoadError } from "@/features/finance-payables/workspace";
import { listPayablesWorkspace } from "@/server/finance-payables";
import { resolveRequestActor } from "@/server/finance-payables/http";

// Step 15B: the Finance Payables workspace. A server component: it resolves the request actor, parses the
// URL into filter state, reads the FIRST bounded, scope-first, deterministic page through the trusted
// service and renders. The proxy already gates /finance/**; the service still checks access, so a denial
// renders ONE neutral state and never leaks anything. `Create Payable` is rendered from the
// SERVER-computed `canManage` permission only (no authorization flash). Filters are URL state; the client
// refreshes this render through router.replace.
export default async function FinancePayablesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const actor = await resolveRequestActor();
  const { state, ignored } = parseWorkspaceUrlState(params);

  const result = await listPayablesWorkspace(actor, toWorkspaceRequest(state));

  if (!result.ok) {
    return <FinancePageShell title={WORKSPACE_TITLE}>{result.code === "unauthorized" ? <WorkspaceDenied /> : <WorkspaceLoadError />}</FinancePageShell>;
  }

  const actions = result.data.permissions.canManage ? (
    <Link className="btn primary" href={NEW_PAYABLE_HREF}>
      Create Payable
    </Link>
  ) : undefined;

  return (
    <FinancePageShell title={WORKSPACE_TITLE} description={WORKSPACE_SUBTITLE} actions={actions}>
      <PayablesWorkspace initial={result.data} state={state} ignoredFilterCount={ignored.length} />
    </FinancePageShell>
  );
}
