import Link from "next/link";

import { FinancePageShell } from "@/features/finance/FinancePageShell";
import { NEW_INVOICE_HREF, parseWorkspaceUrlState, InvoicesWorkspace, toWorkspaceRequest, WORKSPACE_SUBTITLE, WORKSPACE_TITLE, WorkspaceDenied, WorkspaceLoadError } from "@/features/finance-invoices/workspace";
import { listInvoicesWorkspace } from "@/server/finance-invoices";
import { resolveRequestActor } from "@/server/finance-invoices/http";

// Step 16B: the Finance Invoices workspace. A server component: it resolves the request actor,
// parses the URL into filter state, reads the FIRST bounded, scope-first, deterministic page
// through the trusted service and renders. The proxy already gates /finance/**; the service still
// checks access, so a denial renders ONE neutral state and never leaks anything. `Create Invoice`
// is rendered from the SERVER-computed `canManage` permission only (no authorization flash).
// Filters are URL state; the client refreshes this render through router.replace.
export default async function FinanceInvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const actor = await resolveRequestActor();
  const { state, ignored } = parseWorkspaceUrlState(params);

  const result = await listInvoicesWorkspace(actor, toWorkspaceRequest(state));

  if (!result.ok) {
    return <FinancePageShell title={WORKSPACE_TITLE}>{result.code === "unauthorized" ? <WorkspaceDenied /> : <WorkspaceLoadError />}</FinancePageShell>;
  }

  const actions = result.data.permissions.canManage ? (
    <Link className="btn primary" href={NEW_INVOICE_HREF}>
      Create Invoice
    </Link>
  ) : undefined;

  return (
    <FinancePageShell title={WORKSPACE_TITLE} description={WORKSPACE_SUBTITLE} actions={actions}>
      <InvoicesWorkspace initial={result.data} state={state} ignoredFilterCount={ignored.length} />
    </FinancePageShell>
  );
}
