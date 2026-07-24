"use client";

import { useEffect, useState } from "react";

import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui";

/**
 * Dashboard route-level error boundary.
 *
 * Catches errors thrown during render or in effects of any route under
 * `(dashboard)/`. The default view shows the generic "This section failed to
 * load" message + a "Try again" button. A "Show details" toggle reveals the
 * actual error message + stack so we can diagnose without devtools — the
 * boundary logs to console.error either way.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  const description = error.digest
    ? `An unexpected error occurred. Error ID: ${error.digest}`
    : "An unexpected error occurred while loading this view. Please try again.";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-10">
      <ErrorState
        className="w-full max-w-lg"
        title="This section failed to load"
        description={description}
        cta={{ label: "Try again", onClick: () => reset() }}
      />
      <Button variant="ghost" size="sm" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? "Hide details" : "Show details"}
      </Button>
      {showDetails && (
        <pre className="max-h-72 w-full max-w-2xl overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
        </pre>
      )}
    </div>
  );
}
