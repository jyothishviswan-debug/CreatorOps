"use client";

// Step 14B.1 onboarding: the RECEIVING end of the hand-off. When the wizard completes, the browser navigates to the normal intake of the new
// draft and the whole form remounts. The newly mounted provider calls this hook: it takes the hand-off the wizard left in memory (once), announces
// it, and - if the File the person selected is still in memory - sends it through the ordinary upload -> extract -> attach flow so the remaining
// sections (Cross-verification, Commercial terms, KYC, Review) work on the persisted extraction. If the File is gone (a reload) nothing is lost:
// the records exist and the normal Contract source section asks for the file again.
import { useCallback, useEffect, useRef, useState } from "react";

import { describeReupload, takeOnboardingHandoff, type ReuploadResult } from "./handoff";
import { intakeSectionAnchor } from "../intake-progress";

// `retryable`: it failed and the File is still in memory, so it can be sent again.
export type HandoffStatus = { status: "idle" | "running" | "done" | "failed"; message: string | null; retryable: boolean };

export type UseOnboardingHandoffDeps = {
  agreementRef: string | null;
  // upload -> extract -> attach (null = refused because another write was in flight).
  extractAndAttach: (file: File) => Promise<ReuploadResult | null>;
  notify: (tone: "info" | "success" | "warning" | "error", message: string, id?: string) => void;
  // Scrolls to and focuses an anchor.
  focusAnchor: (anchorId: string) => boolean;
  // Records the intended platforms on a Partner-level draft (the `platforms` field); resolves false when it could not be written.
  recordPlatforms: (platforms: string[]) => Promise<boolean>;
};

export function useOnboardingHandoff(deps: UseOnboardingHandoffDeps): { handoff: HandoffStatus; canRetry: boolean; retry: () => void } {
  const { agreementRef } = deps;
  const [handoff, setHandoff] = useState<HandoffStatus>({ status: "idle", message: null, retryable: false });
  const fileRef = useRef<File | null>(null);
  const startedRef = useRef(false);
  // The newest callbacks, so the effect below runs once but never calls a stale one.
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  const run = useCallback(async (file: File) => {
    setHandoff({ status: "running", message: "Adding the signed Agreement to the draft…", retryable: false });
    const result = await depsRef.current.extractAndAttach(file);
    if (result === null) {
      setHandoff({ status: "failed", message: "Another action was still in progress. Try again.", retryable: true });
      return;
    }
    const view = describeReupload(result);
    depsRef.current.notify(view.tone, view.message, "onboarding-handoff");
    if (result.ok) {
      // Sent: the File is no longer needed in memory.
      fileRef.current = null;
      setHandoff({ status: "done", message: view.message, retryable: false });
    } else {
      setHandoff({ status: "failed", message: view.message, retryable: true });
    }
    depsRef.current.focusAnchor(intakeSectionAnchor(view.nextSection));
  }, []);

  useEffect(() => {
    if (startedRef.current || !agreementRef) return;
    startedRef.current = true;
    const held = takeOnboardingHandoff(agreementRef);
    if (!held) return;
    depsRef.current.notify("success", held.announcement, "onboarding-complete");
    const platforms = held.recordPlatforms ?? [];
    const file = held.file;
    fileRef.current = file;
    // Deliberately started from a timer, not from the effect body: the hand-off was already taken above, so a strict-mode re-run of this effect
    // finds nothing to take (and must not cancel this).
    setTimeout(() => {
      void (async () => {
        if (platforms.length > 0) {
          const recorded = await depsRef.current.recordPlatforms(platforms);
          if (!recorded) depsRef.current.notify("warning", "The Agreement was started, but the intended platforms could not be recorded. Set them in Cross-verification.", "platforms-record");
        }
        if (file) await run(file);
        else depsRef.current.focusAnchor(intakeSectionAnchor("contract_source"));
      })();
    }, 0);
  }, [agreementRef, run]);

  const retry = useCallback(() => {
    if (fileRef.current) void run(fileRef.current);
  }, [run]);

  return { handoff, canRetry: handoff.status === "failed" && handoff.retryable, retry };
}
