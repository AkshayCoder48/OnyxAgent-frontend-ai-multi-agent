import { redirect } from "next/navigation";

/**
 * Root page — redirects to /chat.
 *
 * The dashboard layout's AuthGuard will redirect to /login if the user isn't
 * authenticated or the vault isn't unlocked. This avoids a redirect loop:
 *   / → /chat → (AuthGuard: not authed) → /login → (user logs in) → /chat
 *
 * Redirecting to /login directly would cause issues when the user IS already
 * authenticated (login form bounces to /chat, which bounces back to /login
 * if vault isn't unlocked yet).
 */
export default function HomePage() {
  redirect("/chat");
}
