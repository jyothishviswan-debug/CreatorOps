import type { InputHTMLAttributes, ReactNode } from "react";

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="tablewrap">
      <table>{children}</table>
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function SearchInput({
  placeholder,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="inputwrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </svg>
      <input type="search" placeholder={placeholder} {...rest} />
    </div>
  );
}

export function PersonCell({
  name,
  meta,
  initials,
}: {
  name: string;
  meta?: string;
  initials: string;
}) {
  return (
    <div className="person">
      <span className="avatar">{initials}</span>
      <div>
        <b>{name}</b>
        {meta && <small>{meta}</small>}
      </div>
    </div>
  );
}
