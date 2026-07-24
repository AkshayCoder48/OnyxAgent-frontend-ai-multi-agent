"use client";

/**
 * Non-auth guard.
 *
 * The app runs entirely locally with no login. This component is kept as a
 * thin wrapper so the dashboard layout's import chain still works, but it
 * no longer performs any authentication checks — it just renders children.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
