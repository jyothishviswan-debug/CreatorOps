import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { getFinanceWorkspace } from "@/features/finance/fixtures";

const TABS = [
  { label: "Overview", href: "/finance" },
  { label: "Agreements", href: "/finance/agreements" },
  { label: "Payables", href: "/finance/payables" },
  { label: "Invoices", href: "/finance/invoices" },
  { label: "Payments", href: "/finance/payments" },
];

export default function FinanceInvoicesPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">FINANCE & SETTLE</div>
          <h1>Invoices</h1>
          <p>Invoice submission and acceptance status.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <WorkspaceView workspace={getFinanceWorkspace("invoices")} />
    </AppShell>
  );
}
