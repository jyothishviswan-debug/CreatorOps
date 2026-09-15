"use client";

import { useEffect, useRef, type ReactNode } from "react";

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

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dialogtitle">
      <div className="dialoghead">
        <h2 id="dialogtitle">{title}</h2>
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
