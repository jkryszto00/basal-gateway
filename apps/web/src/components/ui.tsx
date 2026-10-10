import type { ComponentProps } from "react";

export const inputClass =
  "w-full rounded-md border border-line bg-card px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-accent-fg hover:opacity-90",
    ghost: "border border-line hover:bg-line/50",
    danger: "text-danger hover:bg-danger/10",
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`rounded-lg border border-line bg-card ${className}`} {...props} />;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </Card>
  );
}
