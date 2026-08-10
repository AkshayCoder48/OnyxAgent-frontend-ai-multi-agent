"use client";

import * as React from "react";
import { Info, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `callout` — info / warn / success / error alert.
 *
 * Props:
 *   - variant ("info" | "warn" | "success" | "error", default "info")
 *   - title (string)
 *   - body (string)
 */
export function Callout({ props, streaming }: GenUIComponentProps) {
  const variant = str(props.variant || props.tone || props.type || props.color, "info") as "info" | "warn" | "success" | "error";
  const title = str(props.title);
  const body = str(props.body || props.text || props.description || props.content);

  if (streaming && !title && !body) {
    return (
      <div className="bg-muted/50 h-16 w-full animate-pulse rounded-2xl border" />
    );
  }

  const alertVariant =
    variant === "error"
      ? "destructive"
      : variant === "success"
        ? "success"
        : variant === "warn"
          ? "warning"
          : "default";

  const Icon =
    variant === "error"
      ? XCircle
      : variant === "success"
        ? CheckCircle2
        : variant === "warn"
          ? AlertTriangle
          : Info;

  return (
    <Alert variant={alertVariant}>
      <Icon className="h-4 w-4" />
      {title && <AlertTitle>{title}</AlertTitle>}
      {body && <AlertDescription>{body}</AlertDescription>}
    </Alert>
  );
}

export default Callout;
