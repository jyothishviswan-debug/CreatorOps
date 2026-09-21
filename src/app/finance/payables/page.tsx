import { WorkspaceView } from "@/ui/WorkspaceView";
import { getFinanceWorkspace } from "@/features/finance/fixtures";
import { FinancePageShell } from "@/features/finance/FinancePageShell";

export default function FinancePayablesPage() {
  return (
    <FinancePageShell title="Payables" description="Monthly payables awaiting approval, review or settlement.">
      <WorkspaceView workspace={getFinanceWorkspace("payables")} />
    </FinancePageShell>
  );
}
