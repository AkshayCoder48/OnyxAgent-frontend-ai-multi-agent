"use client";

/**
 * GenUI shared component helpers — safe prop access + streaming shimmer.
 *
 * Every renderer receives `props: Record<string, unknown>` and must degrade
 * gracefully on missing/invalid values (never crash the chat). These helpers
 * provide type-safe extraction with sensible defaults.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import type { GenUINode } from "@/lib/genui/types";

/** Shared props every GenUI renderer receives. */
export interface GenUIComponentProps {
  props: Record<string, unknown>;
  children?: GenUINode[];
  /** True while the spec is still streaming in — show shimmer placeholder. */
  streaming?: boolean;
  /** Recursively render child nodes (provided by GenUIBlock). */
  renderChildren?: (nodes: GenUINode[]) => React.ReactNode;
}

/** Extract a string prop, with a default. Coerces primitives to string. */
export function str(
  value: unknown,
  fallback: string = "",
): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

/** Extract a number prop, with a default. Returns NaN→fallback. */
export function num(
  value: unknown,
  fallback: number = 0,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Extract a boolean prop, with a default. Strings "true"/"false" coerced. */
export function bool(
  value: unknown,
  fallback: boolean = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

/** Extract an array prop. Returns empty array if not an array. */
export function arr<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Extract an object prop. Returns empty object if not an object. */
export function obj(
  value: unknown,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Shimmer placeholder shown while a GenUI block is streaming in. Matches the
 * chat's existing `shimmer` class (defined in globals.css) so it feels native.
 */
export function ShimmerPlaceholder({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-4",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label="Loading rich content"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="shimmer h-2.5 rounded-full"
          style={{ width: `${85 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Wrap children: if `streaming` is true AND children is empty/null, show the
 * shimmer placeholder instead. Once real content arrives, render it.
 */
export function StreamingWrap({
  streaming,
  children,
  shimmerRows = 3,
  shimmerClassName,
}: {
  streaming?: boolean;
  children: React.ReactNode;
  shimmerRows?: number;
  shimmerClassName?: string;
}) {
  const hasContent = React.Children.count(children) > 0;
  if (streaming && !hasContent) {
    return <ShimmerPlaceholder rows={shimmerRows} className={shimmerClassName} />;
  }
  return <>{children}</>;
}

/** Tailwind grid columns class for a 1-4 column count. */
export function gridCols(count: number): string {
  const c = Math.max(1, Math.min(4, Math.floor(count || 2)));
  const map: Record<number, string> = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-2 lg:grid-cols-4",
  };
  return map[c] ?? map[2]!;
}
