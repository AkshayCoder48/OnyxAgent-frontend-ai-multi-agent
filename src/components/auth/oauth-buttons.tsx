"use client";

/**
 * Backendless mode: no OAuth.
 *
 * The original app offered "Continue with Google / GitHub / Microsoft" via a
 * FastAPI backend that brokered OAuth. In backendless mode there is no server
 * to hold OAuth client secrets or run the callback flow — so these components
 * are kept as no-op stubs purely so existing imports (`<OAuthBlock />` in the
 * login + register forms) keep rendering without a code change.
 *
 * They always render `null`. If you want social-style login in backendless
 * mode, you'd have to ship a public OAuth client (e.g. Google One Tap) and
 * store the resulting identity in the local vault yourself.
 */

interface OAuthButtonsProps {
  /** Ignored — kept for backwards compatibility. */
  next?: string;
  /** Ignored — kept for backwards compatibility. */
  variant?: "signin" | "signup";
}

export function OAuthButtons(_props: OAuthButtonsProps): null {
  return null;
}

export function OAuthBlock(_props: {
  label?: string;
  variant?: "signin" | "signup";
}): null {
  return null;
}

export function OAuthDivider({ label = "or" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <span className="bg-foreground/15 h-px flex-1" />
      <span className="text-foreground/45 font-mono text-[11px] tracking-wider uppercase">
        {label}
      </span>
      <span className="bg-foreground/15 h-px flex-1" />
    </div>
  );
}
