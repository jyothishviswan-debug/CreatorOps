import type { ModuleTab } from "@/ui/module-tabs-active";

// Step 14B: the ONE canonical Finance module sub-navigation. Before this step the same five-entry
// array was copy-pasted into every Finance page (Overview, Agreements, Payables, Invoices,
// Payments); it now lives here and every Finance page renders it through FinancePageShell, so the
// tab row can never drift between them.
//
// Only `Agreements` carries `activePrefixes`: the Agreements workspace has nested routes
// (/finance/agreements/new and /finance/agreements/<ref>) and the default "pathname equals href"
// rule would leave the whole row without a current tab there. The other four tabs keep the default
// exact-match behavior, unchanged.
export const FINANCE_AGREEMENTS_HREF = "/finance/agreements";

export const FINANCE_TABS: ModuleTab[] = [
  { label: "Overview", href: "/finance" },
  { label: "Agreements", href: FINANCE_AGREEMENTS_HREF, activePrefixes: [FINANCE_AGREEMENTS_HREF] },
  { label: "Payables", href: "/finance/payables" },
  { label: "Invoices", href: "/finance/invoices" },
  { label: "Payments", href: "/finance/payments" },
];

// The eyebrow every Finance module page uses (fixture Overview + the four sub pages).
export const FINANCE_EYEBROW = "FINANCE & SETTLE";
