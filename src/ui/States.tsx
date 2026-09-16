import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons";

export function StateGrid({ children }: { children: ReactNode }) {
  return <div className="stategrid">{children}</div>;
}

export function StateCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="statecard">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <>
      {Array.from({ length: lines }).map((_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = "search",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="stateempty">
      <Icon name={icon} />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
