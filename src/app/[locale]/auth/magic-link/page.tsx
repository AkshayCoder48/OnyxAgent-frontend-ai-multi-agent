"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Backendless mode: magic-link verification is gone.
 *
 * The original page POSTed a `?token=...` to `/auth/magic-link/verify` and
 * redirected to /chat on success. In backendless mode there is no server to
 * issue or verify magic-link tokens, so this page just bounces the visitor to
 * the login page where they can unlock their local vault with a passphrase.
 */
export default function MagicLinkVerifyPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return null;
}
