import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import type { Locale } from "@/i18n";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return pageMetadata({
    title: "Reset your passphrase",
    description: "Wipe the local vault and start over.",
    path: "/reset-password",
    locale,
    noindex: true,
  });
}

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Backendless reset-password page.
 *
 * In the original app this page expected a `?token=...` from a reset email.
 * In backendless mode there is no email and no server, so the page just
 * renders the reset form (which offers a destructive "Reset local vault"
 * button) regardless of whether a token is present.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token} />;
}
