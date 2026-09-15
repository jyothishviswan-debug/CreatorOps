import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons";

type Tone = "orange" | "blue" | "green" | "purple";

export function KpiCard({
  icon,
  tone = "orange",
  label,
  value,
  trend,
}: {
  icon: IconName;
  tone?: Tone;
  label: string;
  value: string;
  trend?: string;
}) {
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span>{label}</span>
        <span className={tone === "orange" ? "tile" : `tile ${tone}`}>
          <Icon name={icon} />
        </span>
      </div>
      <div className="value">{value}</div>
      {trend && <div className="trend">{trend}</div>}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="kpis">{children}</div>;
}
