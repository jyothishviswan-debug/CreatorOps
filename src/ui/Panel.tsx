import type { ReactNode } from "react";

export function Panel({
  span,
  children,
}: {
  span?: 3 | 4 | 5 | 6 | 7 | 8 | 12;
  children: ReactNode;
}) {
  return <div className={span ? `panel s${span}` : "panel"}>{children}</div>;
}

export function PanelHead({
  title,
  description,
  link,
}: {
  title: string;
  description?: string;
  link?: ReactNode;
}) {
  return (
    <div className="panelhead">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {link && (
        <span className="textlink" role="link">
          {link}
        </span>
      )}
    </div>
  );
}

export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="panelbody">{children}</div>;
}

export function PanelFoot({ children }: { children: ReactNode }) {
  return <div className="panelfoot">{children}</div>;
}

export function PanelGrid({ children }: { children: ReactNode }) {
  return <div className="grid">{children}</div>;
}
