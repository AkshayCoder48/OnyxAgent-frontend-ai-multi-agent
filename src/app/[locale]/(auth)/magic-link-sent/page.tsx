import { redirect } from "next/navigation";

/**
 * Backendless mode: magic links no longer exist.
 *
 * The original app sent a one-time sign-in link to the user's email; this
 * page confirmed the email was on its way. In backendless mode there is no
 * server, no email, and no magic-link token — visitors landing here are
 * bounced to the login page where they can unlock their local vault with a
 * passphrase.
 */
export default function MagicLinkSentPage() {
  redirect("/login");
}
