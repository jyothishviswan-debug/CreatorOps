import type { ReactNode } from "react";

export function FormLayout({ children }: { children: ReactNode }) {
  return <div className="formlayout">{children}</div>;
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="formsection">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <div className="fields">{children}</div>;
}

export function Field({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={full ? "field full" : "field"}>
      <label>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function FormFoot({ children }: { children: ReactNode }) {
  return <div className="formfoot">{children}</div>;
}

export function Checklist({ children }: { children: ReactNode }) {
  return <ul className="checklist">{children}</ul>;
}
