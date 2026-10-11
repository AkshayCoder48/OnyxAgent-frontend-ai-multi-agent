import { redirect } from "next/navigation";

/**
 * Root page — redirects to /chat.
 *
 * The dashboard layout's AuthGuard will redirect to /login if the user isn't
 * authenticated or the vault isn't unlocked. This avoids a redirect loop:
 *   / → /chat → (AuthGuard: not authed) → /login → (user logs in) → /chat
 *
 * Redirecting to /login directly would cause issues when the user IS already
 * authenticated (login form bounces to /chat, and it would bounce back to
 * /login if the vault isn't unlocked yet).
 *
 * EXCEPTION — Pollinations OAuth return trip: the official callback route
 * (/api/auth/pollinations/callback) sends the user back to
 * `/?pollinations_code=…&pollinations_state=…` (or `?pollinations_error=…`).
 * A bare redirect("/chat") would DROP the query string and lose the one-time
 * authorization code, so when those params are present we redirect to the
 * Pollinations settings section (which completes the exchange server-side
 * and cleans the URL) with the query preserved.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const code = typeof params.pollinations_code === "string" ? params.pollinations_code : "";
  const error = typeof params.pollinations_error === "string" ? params.pollinations_error : "";
  const state = typeof params.pollinations_state === "string" ? params.pollinations_state : "";
  if (code || error) {
    const qs = new URLSearchParams();
    if (code) qs.set("pollinations_code", code);
    if (state) qs.set("pollinations_state", state);
    if (error) qs.set("pollinations_error", error);
    redirect(`/settings/pollinations?${qs.toString()}`);
  }
  redirect("/chat");
}
