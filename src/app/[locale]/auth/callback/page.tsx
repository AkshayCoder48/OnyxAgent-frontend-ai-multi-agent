"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Backendless mode: no OAuth callback.
 *
 * The original page received `?access_token=…&refresh_token=…` from an OAuth
 * provider, posted them to `/auth/oauth-callback`, and redirected to
 * /dashboard. In backendless mode there is no server, no JWT, and no OAuth
 * broker — visitors landing here are bounced to the login page.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return null;
}
