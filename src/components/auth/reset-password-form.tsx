"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ShieldAlert, Trash2 } from "lucide-react";

import { Button } from "@/components/ui";
import { ROUTES } from "@/lib/constants";
import { wipeAllData } from "@/lib/db";
import { setVault } from "@/lib/crypto/vault";
import { useAuthStore } from "@/stores";

interface Props {
  /** Ignored in backendless mode — kept for backwards compatibility with
   *  the reset-password page which still passes a `?token=` from the URL. */
  token?: string;
}

/**
 * Backendless "reset password" form.
 *
 * The original flow expected a one-time token from a reset email. In
 * backendless mode there is no email and no server, so this form instead
 * offers the same destructive "Reset local vault" action as the forgot-password
 * page: wipe IndexedDB, clear the in-memory vault key, and bounce the user to
 * the register page.
 */
export function ResetPasswordForm(_props: Props) {
  const t = useTranslations("auth.resetPassword");
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState(false);
  const logout = useAuthStore((s) => s.logout);

  const handleReset = async () => {
    const confirmed = window.confirm(t("resetVaultConfirm"));
    if (!confirmed) return;

    setResetting(true);
    try {
      await wipeAllData();
      setVault(null);
      await logout();
      setDone(true);
      toast.success(t("resetVaultDone"));
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Failed to reset local vault. Please try again.";
      toast.error(message);
    } finally {
      setResetting(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-7 text-center">
        <div
          className="bg-brand/15 mx-auto flex h-14 w-14 items-center justify-center rounded-full"
          style={{ boxShadow: "0 0 32px oklch(from var(--color-brand) l c h / 0.35)" }}
        >
          <ShieldAlert className="text-foreground h-6 w-6" />
        </div>
        <div className="space-y-2">
          <span className="eyebrow text-foreground/55">{t("eyebrow")}</span>
          <h1 className="text-display-md text-foreground [&_em]:font-accent [&_em]:font-normal [&_em]:italic">
            Vault cleared. <em>Start fresh.</em>
          </h1>
          <p className="text-foreground/70 text-sm">{t("resetVaultDone")}</p>
        </div>
        <Link
          href={ROUTES.REGISTER}
          className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors"
        >
          Create a new account
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="eyebrow text-foreground/55">{t("eyebrow")}</span>
        <h1 className="text-display-md text-foreground [&_em]:font-accent [&_em]:font-normal [&_em]:italic">
          {t("heading")}
        </h1>
        <p className="text-foreground/65 text-sm">{t("intro")}</p>
      </div>

      <div className="border-foreground/10 bg-foreground/[0.03] space-y-4 rounded-2xl border px-5 py-5">
        <div className="space-y-1">
          <h2 className="text-foreground text-sm font-semibold">
            {t("resetVaultHeading")}
          </h2>
          <p className="text-foreground/70 text-xs leading-relaxed">{t("resetVaultBody")}</p>
        </div>

        <Button
          type="button"
          onClick={handleReset}
          disabled={resetting}
          variant="destructive"
          className="h-11 w-full rounded-full text-sm font-medium"
        >
          {resetting ? (
            t("resetVaultResetting")
          ) : (
            <>
              <Trash2 className="mr-2 h-4 w-4" />
              {t("resetVaultButton")}
            </>
          )}
        </Button>
      </div>

      <Link
        href={ROUTES.LOGIN}
        className="text-foreground/55 hover:text-foreground inline-flex items-center gap-2 text-sm font-medium"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToSignIn")}
      </Link>
    </div>
  );
}
