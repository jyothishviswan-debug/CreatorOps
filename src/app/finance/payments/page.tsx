import { WorkspaceView } from "@/ui/WorkspaceView";
import { getFinanceWorkspace } from "@/features/finance/fixtures";
import { FinancePageShell } from "@/features/finance/FinancePageShell";

export default function FinancePaymentsPage() {
  return (
    <FinancePageShell title="Payments" description="Recorded and scheduled payments.">
      <WorkspaceView workspace={getFinanceWorkspace("payments")} />
    </FinancePageShell>
  );
}
