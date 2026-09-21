// Step 14B: the ONE Finance module page shell (server-safe: no state, no effects). It renders exactly
// the structure the five Finance pages each rendered inline before this step:
//
//   AppShell > [div.ov-page >] div.head + ModuleTabs(FINANCE_TABS) + children
//
// `overviewFrame` adds the `.ov-page` wrapper the Overview page has always used (it changes the frame's
// max-width / padding via `.main:has(> .ov-page)`), so the Overview keeps its exact layout while the
// four sub pages keep theirs. Detail / New pages must NOT use this shell: they are AppShell > .head with
// no module tab row (like every other module's detail page).
import type { ReactNode } from "react";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";

import { FINANCE_EYEBROW, FINANCE_TABS } from "./finance-tabs";

export function FinancePageShell({
  eyebrow = FINANCE_EYEBROW,
  title,
  description,
  actions,
  overviewFrame = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  overviewFrame?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>

      <ModuleTabs tabs={FINANCE_TABS} />

      {children}
    </>
  );
  return <AppShell>{overviewFrame ? <div className="ov-page">{body}</div> : body}</AppShell>;
}
