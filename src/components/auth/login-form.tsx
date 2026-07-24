"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, ShieldCheck } from "lucide-react";

import { OAuthBlock } from "@/components/auth/oauth-buttons";
import { Button, Input, Label } from "@/components/ui";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores";
import { ApiError } from "@/lib/api-client";
import { ROUTES } from "@/lib/constants";
import { EMAIL_RE } from "@/lib/utils";

export function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const { login, user, isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const vaultUnlocked = useAuthStore((s) => s.vaultUnlocked);
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  // Only redirect to /chat if the vault is actually unlocked — not just if
  // isAuthenticated is true. In backendless mode, isAuthenticated just means
  // a user record exists in IndexedDB; vaultUnlocked means the user has
  // entered their passphrase this session (or it was restored from
  // sessionStorage). Without this check, the login page bounces to /chat,
  // AuthGuard bounces back to /login (vault locked), and we get an infinite
  // redirect loop.
  useEffect(() => {
    if (!isAuthLoading && isAuthenticated && user && vaultUnlocked) {
      router.push(ROUTES.CHAT);
    }
  }, [isAuthLoading, isAuthenticated, user, vaultUnlocked, router]);

  const emailValid = !email || EMAIL_RE.test(email);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      // `login` unlocks the local passphrase vault (see @/lib/crypto/vault +
      // @/lib/services authService). The hook routes to /chat on success.
      await login(email, passphrase);
      toast.success(t("loginSuccess"));
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : "Login failed. Please try again.";
      setError(message);
      toast.error(message);
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="eyebrow text-foreground/55">{t("welcomeBack")}</span>
        <h1 className="text-display-md text-foreground [&_em]:font-accent [&_em]:font-normal [&_em]:italic">
          Sign in to <em>your workspace.</em>
        </h1>
        <p className="text-foreground/65 text-sm">
          {t("noAccount")}{" "}
          <Link
            href={ROUTES.REGISTER}
            className="text-foreground hover:text-foreground/80 font-medium underline-offset-4 hover:underline"
          >
            {t("register")}
          </Link>
        </p>
      </div>

      <div
        className="border-foreground/10 bg-foreground/[0.03] flex items-start gap-3 rounded-xl border px-4 py-3"
        role="note"
      >
        <ShieldCheck className="text-foreground/55 mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="text-foreground/70 text-xs leading-relaxed">{t("localFirstNotice")}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <Label
            htmlFor="email"
            className="text-foreground/80 text-xs font-medium tracking-wider uppercase"
          >
            {t("email")}
          </Label>
          <Input
            id="email"
            type="email"
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setEmailTouched(true)}
            required
            disabled={isLoading}
            autoComplete="email"
            className={`h-12 rounded-xl ${emailTouched && email && !emailValid ? "border-destructive" : ""}`}
          />
          {emailTouched && email && !emailValid && (
            <p className="text-destructive text-xs">{t("emailRequired")}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="passphrase"
              className="text-foreground/80 text-xs font-medium tracking-wider uppercase"
            >
              {t("passphrase")}
            </Label>
            <Link
              href={ROUTES.FORGOT_PASSWORD}
              className="text-foreground/55 hover:text-foreground text-xs font-medium underline-offset-4 hover:underline"
            >
              {t("forgotShort")}
            </Link>
          </div>
          <Input
            id="passphrase"
            type="password"
            placeholder="••••••••"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
            disabled={isLoading}
            autoComplete="current-password"
            className="h-12 rounded-xl"
          />
        </div>

        {error && (
          <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={isLoading}
          className="bg-foreground text-background hover:bg-foreground/90 h-12 w-full rounded-full text-base font-medium"
        >
          {isLoading ? (
            t("loggingIn")
          ) : (
            <>
              {t("login")}
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </form>

      {/* Backendless mode: no OAuth. Rendered as null, kept for layout parity. */}
      <OAuthBlock label={t("orSignInWith")} />
    </div>
  );
}
