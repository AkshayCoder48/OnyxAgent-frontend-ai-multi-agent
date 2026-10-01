import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SectionCardProps {
  title: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
}

export function SectionCard({ title, description, action, children }: SectionCardProps) {
  return (
    <section className="border-border bg-card rounded-xl border">
      {/* items-center: the action button is vertically balanced against the
          title + description column instead of hugging the top edge. The
          header wraps on narrow screens so the action never overflows. */}
      <header className="border-border flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-sm leading-snug font-semibold">{title}</h2>
          {description && (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children && <div className="px-5 py-5">{children}</div>}
    </section>
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  /** Right-aligned action (e.g. "Save changes" button). */
  action?: ReactNode;
  /** Subdued danger styling for destructive sections. */
  danger?: boolean;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  title,
  description,
  action,
  danger,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section
      className={cn(
        "bg-card rounded-2xl border p-5 sm:p-6",
        danger ? "border-destructive/30 bg-destructive/[0.03]" : "border-foreground/10",
        className,
      )}
    >
      {/* items-center keeps the action vertically balanced against the
          title + description column; flex-wrap degrades gracefully. */}
      <header
        className={cn("flex flex-wrap items-center justify-between gap-3", children ? "mb-5" : "")}
      >
        <div className="min-w-0 flex-1">
          <h2
            className={cn(
              "font-display text-base leading-snug font-semibold tracking-tight",
              danger ? "text-destructive" : "text-foreground",
            )}
          >
            {title}
          </h2>
          {description && (
            <p className="text-foreground/65 mt-1 text-sm leading-relaxed">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  description?: string;
  /** Form/control on the right — stacks below the label on mobile. */
  control: ReactNode;
  /**
   * Vertical alignment of the control against the label/description column
   * on sm+. "center" (default) suits single-line toggles/selects/inputs;
   * use "start" only for genuinely tall controls (textareas, button groups).
   */
  align?: "center" | "start";
  className?: string;
}

export function SettingsRow({
  label,
  description,
  control,
  align = "center",
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        "border-foreground/8 flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:gap-6",
        align === "start" ? "sm:items-start" : "sm:items-center",
        className,
      )}
    >
      {/* Label column: min-w-0 so long labels/descriptions wrap instead of
          pushing the control out of the card. */}
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm leading-snug font-medium">{label}</p>
        {description && (
          <p className="text-foreground/55 mt-1 text-xs leading-relaxed">{description}</p>
        )}
      </div>
      {/* Control column: full-width on mobile, right-aligned on sm+. Wrapping
          + min-w-0 keep the control inside the card — no forced shrink-0. */}
      <div className="flex min-w-0 max-w-full flex-wrap justify-start sm:justify-end">
        {control}
      </div>
    </div>
  );
}
