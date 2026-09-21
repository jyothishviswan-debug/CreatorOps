import { WorkspaceView } from "@/ui/WorkspaceView";
import { getFinanceWorkspace } from "@/features/finance/fixtures";
import { FinancePageShell } from "@/features/finance/FinancePageShell";

export default function FinanceInvoicesPage() {
  return (
    <FinancePageShell title="Invoices" description="Invoice submission and acceptance status.">
      <WorkspaceView workspace={getFinanceWorkspace("invoices")} />
    </FinancePageShell>
  );
}
