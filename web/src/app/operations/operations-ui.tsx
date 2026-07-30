import type { PropsWithChildren, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Surface({
  className,
  children,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-stone-200/80 bg-white shadow-[0_12px_32px_rgba(28,25,23,0.05)] dark:border-white/10 dark:bg-stone-950 dark:shadow-none",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-stone-200/80 px-5 py-5 sm:flex-row sm:items-start sm:justify-between dark:border-white/10">
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-[0.16em] text-violet-700 uppercase dark:text-violet-300">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-xl font-bold tracking-tight text-stone-950 dark:text-white">
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-500 dark:text-stone-400">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
      <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-stone-950 dark:text-white">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: PropsWithChildren) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 px-5 py-10 text-center text-sm text-stone-500 dark:border-white/15 dark:text-stone-400">
      {children}
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const positive = [
    "success",
    "completed",
    "closed",
    "healthy",
    "consume",
  ].includes(normalized);
  const warning = [
    "queued",
    "pending",
    "retry",
    "half_open",
    "reserve",
  ].includes(normalized);
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center rounded-full px-2 text-[11px] font-semibold",
        positive
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
          : warning
            ? "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
            : "bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300",
      )}
    >
      {value || "—"}
    </span>
  );
}
