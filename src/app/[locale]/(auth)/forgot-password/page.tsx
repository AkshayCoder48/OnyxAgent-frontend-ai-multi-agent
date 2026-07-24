import type { Metadata } from "next";

import { ForgotPasswordForm } from "@/components/auth";
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
    path: "/forgot-password",
    locale,
    noindex: true,
  });
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
