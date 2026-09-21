import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { AgreementDetail } from "@/features/finance-agreements/detail/AgreementDetail";
import { parseDetailTab, parseVersionParam } from "@/features/finance-agreements/detail/detail-model";
import { defaultViewedVersion, priorVersionNumber } from "@/features/finance-agreements/detail/versions-view";
import { computeFinanceAgreementPermissions, getAgreementDetail, getAgreementKycStatus, getAgreementReconciliation } from "@/server/finance-agreements";
import type { AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import { resolveRequestActor } from "@/server/finance-agreements/http";

// Step 14B: /finance/agreements/[agreementRef]?tab=&version=
// `params` and `searchParams` are Promises. Access is decided HERE, before anything renders (no authorization flash): the Finance services answer
// every out-of-scope, missing or forged ref with ONE neutral not-found and every feature / action denial with ONE neutral denied, and this page renders
// exactly those two states - it never says which check failed. Action buttons are rendered from the server-computed permission booleans.
export default async function AgreementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agreementRef: string }>;
  searchParams: Promise<{ tab?: string | string[]; version?: string | string[] }>;
}) {
  const { agreementRef } = await params;
  const { tab, version } = await searchParams;
  const actor = await resolveRequestActor();

  // The head, the bounded version summaries and the default version (open, else governing, else newest).
  const first = await getAgreementDetail(actor, agreementRef, {});
  if (!first.ok) {
    if (first.code === "unauthorized") return <Denied />;
    if (first.code === "not_found" || first.code === "invalid_input") notFound();
    return <LoadFailed />;
  }

  const { head, versions, hasMoreVersions } = first.data;
  const permissions = await computeFinanceAgreementPermissions(actor, head.counterparty.type);
  if (!permissions.canView) return <Denied />;

  // Which version to view: ?version= when it exists, else what governs (or governed last), else the open draft, else the newest.
  const notices: string[] = [];
  const requested = parseVersionParam(version);
  let viewNumber = defaultViewedVersion(head);
  if (requested.state === "invalid") notices.push("The requested version is not a valid version number, so the current version is shown.");
  if (requested.state === "valid") {
    const exists = versions.some((entry) => entry.version === requested.version);
    // The summaries are bounded: a version beyond them is still tried (the read below decides).
    if (exists || hasMoreVersions) viewNumber = requested.version;
    else notices.push("This Agreement has no such version, so the current version is shown.");
  }

  // The documents the page needs: the viewed version, the open version, and the version each is compared with (a revision vs the version in force).
  const viewedSummary = versions.find((entry) => entry.version === viewNumber) ?? null;
  const wanted = new Set<number>([viewNumber]);
  if (head.openVersion !== null) {
    wanted.add(head.openVersion);
    const openPrior = head.activeVersion ?? head.lastEndedVersion;
    if (openPrior !== null) wanted.add(openPrior);
  }
  if (viewedSummary) {
    const prior = priorVersionNumber(head, viewedSummary);
    if (prior !== null) wanted.add(prior);
  }

  const docs = new Map<number, AgreementVersionDto>();
  if (first.data.selectedVersion) docs.set(first.data.selectedVersion.version, first.data.selectedVersion);

  const [loaded, reconciliation, kyc] = await Promise.all([
    Promise.all(
      [...wanted]
        .filter((number) => !docs.has(number))
        .map(async (number) => {
          const result = await getAgreementDetail(actor, agreementRef, { version: number });
          return { number, doc: result.ok ? result.data.selectedVersion : null };
        }),
    ),
    getAgreementReconciliation(actor, { agreementRef, version: viewNumber }),
    getAgreementKycStatus(actor, agreementRef),
  ]);
  for (const item of loaded) if (item.doc) docs.set(item.number, item.doc);

  // A requested version that could not be read falls back to what governs (with a notice).
  if (!docs.has(viewNumber)) {
    if (requested.state === "valid") notices.push("This Agreement has no such version, so the current version is shown.");
    viewNumber = defaultViewedVersion(head);
    if (!docs.has(viewNumber)) {
      const fallback = await getAgreementDetail(actor, agreementRef, { version: viewNumber });
      if (fallback.ok && fallback.data.selectedVersion) docs.set(viewNumber, fallback.data.selectedVersion);
    }
  }

  // The client component's state is seeded from these props once; a new key (a changed head, another version) re-seeds it after "Reload latest".
  const stateKey = `${head.agreementRef}:${viewNumber}:${head.docVersion}:${head.updatedAt}`;

  return (
    <AppShell>
      <AgreementDetail
        key={stateKey}
        initialHead={head}
        initialVersions={versions}
        initialHasMoreVersions={hasMoreVersions}
        initialDocs={[...docs.values()]}
        initialViewNumber={viewNumber}
        initialTab={parseDetailTab(tab)}
        permissions={permissions}
        initialReconciliation={reconciliation.ok ? reconciliation.data : null}
        kycStatus={kyc.ok ? kyc.data : null}
        notices={notices}
      />
    </AppShell>
  );
}

// ONE neutral denied state (feature / action denial); it never says which check failed.
function Denied() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Access denied" description="You don't have permission to view this Agreement." icon="lock" />
      </section>
    </AppShell>
  );
}

function LoadFailed() {
  return (
    <AppShell>
      <section className="panel">
        <EmptyState title="Couldn’t load this Agreement" description="Something went wrong while loading it. Try again in a moment." icon="alert" />
      </section>
    </AppShell>
  );
}
