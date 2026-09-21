import Link from "next/link";
import { notFound } from "next/navigation";

import { IntakeForm } from "@/features/finance-agreements/intake/IntakeForm";
import { IntakeProvider } from "@/features/finance-agreements/intake/intake-context";
import { parseIntakeSearchParams } from "@/features/finance-agreements/intake/intake-logic";
import { resolveRequestActor } from "@/server/finance-agreements/http";
import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

import { loadIntakePageState } from "./load-intake-state";

type SearchParams = Record<string, string | string[] | undefined>;

// /finance/agreements/new - the staged Agreement intake (one page, ten sections).
//   ?counterpartyType=&ref=     deep link from a Partner / Vendor page: preselects the counterparty
//   ?agreementRef=&version=     RESUME a draft / revision (the URL Start draft replaces itself with)
// Access is decided here, on the server, BEFORE anything renders: the proxy already gates /finance/**, and this page re-checks through the
// Finance services and shows ONE neutral denied state or ONE neutral not-found (a missing / forged / out-of-scope ref look identical).
// Form actions are rendered from the server-computed permission booleans, so nothing is shown and then hidden.
export default async function NewAgreementPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = parseIntakeSearchParams(await searchParams);
  const actor = await resolveRequestActor();
  const state = await loadIntakePageState(actor, params);

  if (state.kind === "not_found") notFound();

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE / NEW AGREEMENT</div>
          <h1>{state.kind === "ready" ? state.title : "New Agreement"}</h1>
          <p>Choose who the Agreement is with, add the contract, then review and confirm every term.</p>
        </div>
        <div className="actions">
          <Link href="/finance/agreements" className="btn">
            Back to Agreements
          </Link>
        </div>
      </div>

      {state.kind === "denied" ? (
        <section className="panel">
          <EmptyState title="Access denied" description="You do not have access to this view." icon="lock" />
        </section>
      ) : (
        <IntakeProvider key={state.routeKey} permissions={state.permissions} initial={state.initial}>
          <IntakeForm />
        </IntakeProvider>
      )}
    </AppShell>
  );
}
