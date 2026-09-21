import Link from "next/link";

import { FinancePageShell } from "@/features/finance/FinancePageShell";
import { AgreementsWorkspace, NEW_AGREEMENT_HREF, parseWorkspaceUrlState, toWorkspaceRequest, WORKSPACE_DESCRIPTION, WORKSPACE_TITLE, WorkspaceDenied, WorkspaceLoadError } from "@/features/finance-agreements/workspace";
import { listAgreementsWorkspace } from "@/server/finance-agreements";
import { resolveRequestActor } from "@/server/finance-agreements/http";

// Step 14B: the Finance Agreements workspace. A server component: it resolves the request actor, parses the URL into filter
// state, reads the FIRST bounded, scope-first, deterministic page through the trusted service and renders. The proxy already
// gates /finance/**; the service still checks access, so a denial renders ONE neutral state and never leaks anything.
// `New Agreement` is rendered from the SERVER-computed `canManage` permission only (no authorization flash: it is either in the
// first HTML or absent). Filters are URL state; the client refreshes this render through router.replace.
export default async function FinanceAgreementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const actor = await resolveRequestActor();
  const { state, ignored } = parseWorkspaceUrlState(params);

  const result = await listAgreementsWorkspace(actor, toWorkspaceRequest(state));

  if (!result.ok) {
    return <FinancePageShell title={WORKSPACE_TITLE}>{result.code === "unauthorized" ? <WorkspaceDenied /> : <WorkspaceLoadError />}</FinancePageShell>;
  }

  const actions = result.data.permissions.canManage ? (
    <Link className="btn primary" href={NEW_AGREEMENT_HREF}>
      New Agreement
    </Link>
  ) : undefined;

  return (
    <FinancePageShell title={WORKSPACE_TITLE} description={WORKSPACE_DESCRIPTION} actions={actions}>
      <AgreementsWorkspace initial={result.data} state={state} ignoredFilterCount={ignored.length} />
    </FinancePageShell>
  );
}
