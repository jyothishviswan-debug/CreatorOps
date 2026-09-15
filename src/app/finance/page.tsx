import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { financeOverview } from "@/features/finance/fixtures";

const TABS = [
  { label: "Overview", href: "/finance" },
  { label: "Agreements", href: "/finance/agreements" },
  { label: "Payables", href: "/finance/payables" },
  { label: "Invoices", href: "/finance/invoices" },
  { label: "Payments", href: "/finance/payments" },
];

export default function FinanceOverviewPage() {
  const o = financeOverview;
  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">{o.eyebrow}</div>
            <h1>{o.title}</h1>
            <p>{o.description}</p>
          </div>
        </div>

        <ModuleTabs tabs={TABS} />

        <ContextBanner icon="wallet" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
