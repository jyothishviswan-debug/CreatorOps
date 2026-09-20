// Step 12F: the pure, unit-testable "is this tab current?" rule behind
// ModuleTabs. The DEFAULT rule is unchanged from before this step - a tab is
// current only when the pathname equals its href - so every existing module
// keeps its exact behavior. A tab may additionally declare `activePrefixes`
// (opaque path prefixes that also mark it current): Analytics uses this so the
// Partner drill-down (/analytics/partner/<ref>) keeps "Partners" as its parent
// / current tab instead of leaving the whole row without a current tab.
export type ModuleTab = { label: string; href: string; activePrefixes?: string[] };

export function isModuleTabActive(pathname: string | null | undefined, tab: ModuleTab): boolean {
  if (!pathname) return false;
  if (pathname === tab.href) return true;
  return (tab.activePrefixes ?? []).some((prefix) => pathname.startsWith(prefix));
}
