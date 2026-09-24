"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { EmptyState } from "@/ui/States";

import { DENIED_DESCRIPTION, DENIED_TITLE, ERROR_DESCRIPTION, ERROR_TITLE } from "./workspace-copy";

// Step 17B: the two whole-workspace fallback states, rendered by the server page INSTEAD of the
// workspace (the client workspace only ever renders for an authorized, successful read - nothing
// revealed then hidden).
export function WorkspaceDenied() {
  return (
    <section className="panel" style={{ marginTop: 18 }} data-testid="workspace-denied">
      <div className="panelbody">
        <EmptyState title={DENIED_TITLE} description={DENIED_DESCRIPTION} icon="lock" />
      </div>
    </section>
  );
}

export function WorkspaceLoadError() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <section className="panel" style={{ marginTop: 18 }} role="alert" data-testid="workspace-error">
      <div className="panelbody">
        <EmptyState
          title={ERROR_TITLE}
          description={ERROR_DESCRIPTION}
          icon="alert"
          action={
            <button type="button" className="btn" disabled={pending} aria-disabled={pending} onClick={() => startTransition(() => router.refresh())}>
              {pending ? "Retrying…" : "Try again"}
            </button>
          }
        />
      </div>
    </section>
  );
}
