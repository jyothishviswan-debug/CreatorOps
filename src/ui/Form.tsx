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
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  // Finding #33: a field that is genuinely always-required must say so
  // visibly, not just carry the HTML `required` attribute on its input -
  // mirrors the " (required)"/" (optional)" convention already used for
  // conditionally-required reason fields elsewhere in the app.
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={full ? "field full" : "field"}>
      <label>
        {label}
        {required ? " (required)" : ""}
      </label>
      {children}
      {error ? (
        <small className="fielderror" role="alert">
          {error}
        </small>
      ) : (
        hint && <small>{hint}</small>
      )}
    </div>
  );
}

export function FormFoot({ children }: { children: ReactNode }) {
  return <div className="formfoot">{children}</div>;
}

export function Checklist({ children }: { children: ReactNode }) {
  return <ul className="checklist">{children}</ul>;
}
