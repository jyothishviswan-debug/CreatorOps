"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function DialogShell({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // One title id PER dialog: several dialogs can live on one page, and a shared id would name every one of them after the first.
  const titleId = useId();

  // `close()` (called below when `open` turns false) still fires a native "close" event LATER. That echo must not be reported
  // as the user closing the dialog: if the dialog was re-opened in the meantime it would slam the fresh dialog shut again.
  const closedByProp = useRef(false);

  // The control that had focus when the dialog opened. A native <dialog> gives focus back to it on close(), but a dialog that is
  // UNMOUNTED while open (a caller that renders it conditionally) is simply removed from the DOM and focus falls to <body>: the
  // cleanup below puts it back on that control (only when focus was really lost).
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocusTo.current = document.activeElement;
      node.showModal();
    }
    if (!open && node.open) {
      closedByProp.current = true;
      node.close();
    }
  }, [open]);

  useEffect(
    () => () => {
      const target = returnFocusTo.current;
      if (!target) return;
      window.setTimeout(() => {
        if (target.isConnected && (!document.activeElement || document.activeElement === document.body)) target.focus();
      }, 0);
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (closedByProp.current) {
          closedByProp.current = false;
          return;
        }
        onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="dialoghead">
        <h2 id={titleId}>{title}</h2>
        <button className="iconbutton" aria-label="Close dialog" onClick={onClose} type="button">
          ✕
        </button>
      </div>
      <div className="dialogbody">{children}</div>
      {footer && <div className="dialogfoot">{footer}</div>}
    </dialog>
  );
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}
