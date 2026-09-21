// Step 14B intake: jump to an anchor (a section or a field) so a blocker / checklist item can take the person to what needs attention.
// Focus follows the scroll: the target (or its first focusable control) receives focus so keyboard and screen-reader users land there too.
const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function scrollToAnchor(anchorId: string): boolean {
  if (typeof document === "undefined") return false;
  const target = document.getElementById(anchorId);
  if (!target) return false;
  const reduceMotion = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  const focusTarget = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE);
  if (focusTarget) {
    focusTarget.focus({ preventScroll: true });
  } else {
    // A heading / section: make it a temporary focus target without adding a tab stop.
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  return true;
}
