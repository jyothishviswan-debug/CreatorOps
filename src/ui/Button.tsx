import type { ButtonHTMLAttributes } from "react";

import { Icon, type IconName } from "./icons";

type Variant = "default" | "primary" | "ghost";

export function Button({
  variant = "default",
  icon,
  className,
  children,
  ...rest
}: {
  variant?: Variant;
  icon?: IconName;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const variantClass = variant === "default" ? "" : ` ${variant}`;
  return (
    <button type="button" className={`btn${variantClass}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
