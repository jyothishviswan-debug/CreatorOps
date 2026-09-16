import { Suspense } from "react";

import { AppShell } from "@/ui/AppShell";
import { AccessDeniedContent } from "./AccessDeniedContent";

export default function AccessDeniedPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <AccessDeniedContent />
      </Suspense>
    </AppShell>
  );
}
