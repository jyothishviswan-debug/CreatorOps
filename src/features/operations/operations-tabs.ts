import type { ModuleTab } from "@/ui/ModuleTabs";

// Spec: "Operations sibling navigation: Tasks | Approval Queue | Reminders" - exactly the 7 canonical
// routes' three workspace-level siblings. No Overview tab (the Tasks workspace lives at /operations
// itself), no v2/experimental tab.
export const OPERATIONS_TABS: ModuleTab[] = [
  { label: "Tasks", href: "/operations", activePrefixes: ["/operations/tasks"] },
  { label: "Approval Queue", href: "/operations/approvals" },
  { label: "Reminders", href: "/operations/reminders", activePrefixes: ["/operations/reminders"] },
];
