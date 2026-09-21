import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { financeOverview } from "@/features/finance/fixtures";
import { FinancePageShell } from "@/features/finance/FinancePageShell";

export default function FinanceOverviewPage() {
  const o = financeOverview;
  return (
    <FinancePageShell overviewFrame eyebrow={o.eyebrow} title={o.title} description={o.description}>
      <ContextBanner icon="wallet" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

      <OverviewKpiRow items={o.kpis} />
      <OverviewPanels panels={o.topPanels} />
      <OverviewPanels panels={o.bottomPanels} secondary />
    </FinancePageShell>
  );
}
