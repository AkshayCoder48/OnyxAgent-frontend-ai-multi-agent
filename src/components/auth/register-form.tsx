"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, Check, ShieldCheck, X } from "lucide-react";

import { OAuthBlock } from "@/components/auth/oauth-buttons";
import { Button, Input, Label } from "@/components/ui";
import { useAuth } from "@/hooks";
import { ApiError } from "@/lib/api-client";
import { ROUTES } from "@/lib/constants";
import { EMAIL_RE, getPasswordStrength } from "@/lib/utils";

export function RegisterForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const { register, login } = useAuth();
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  const emailValid = !email || EMAIL_RE.test(email);
  const strength = useMemo(() => getPasswordStrength(passphrase), [passphrase]);
  const passphrasesMatch = !confirmPassphrase || passphrase === confirmPassphrase;
  const passphraseLongEnough = !passphrase || passphrase.length >= 8;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!EMAIL_RE.test(email)) {
      setError("Please enter a valid email address");
      return;
    }
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases do not match");
      toast.error("Passphrases do not match");
      return;
    }

    setIsLoading(true);
    try {
      // `register` creates a brand-new local vault on this device — the
      // derived AES-GCM key (from the passphrase via PBKDF2) is held in
      // memory for the session and never persisted.
      await register(email, name || "", passphrase);
      toast.success(t("registerSuccess"));
      // Auto-login so the user lands straight in the app. The login() call
      // unlocks the vault and routes to /chat. If it fails for any reason,
      // fall back to the login page with a "registered=true" hint.
      try {
        await login(email, passphrase);
      } catch {
        router.push(ROUTES.LOGIN + "?registered=true");
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : "Registration failed. Please try again.";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="eyebrow text-foreground/55">{t("getStarted")}</span>
        <h1 className="text-display-md text-foreground [&_em]:font-accent [&_em]:font-normal [&_em]:italic">
          Create your <em>workspace.</em>
        </h1>
        <p className="text-foreground/65 text-sm">
          {t("hasAccount")}{" "}
          <Link
            href={ROUTES.LOGIN}
            className="text-foreground hover:text-foreground/80 font-medium underline-offset-4 hover:underline"
          >
            {t("login")}
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
            htmlFor="name"
            className="text-foreground/80 text-xs font-medium tracking-wider uppercase"
          >
            {t("nameOptional")}
          </Label>
          <Input
            id="name"
            type="text"
            placeholder={t("namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            autoComplete="name"
            className="h-12 rounded-xl"
          />
        </div>

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
          <Label
            htmlFor="passphrase"
            className="text-foreground/80 text-xs font-medium tracking-wider uppercase"
          >
            {t("passphrase")}
          </Label>
          <Input
            id="passphrase"
            type="password"
            placeholder={t("passphrasePlaceholder")}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
            disabled={isLoading}
            autoComplete="new-password"
            className={`h-12 rounded-xl ${passphrase && !passphraseLongEnough ? "border-destructive" : ""}`}
          />
          {passphrase && (
            <div className="space-y-1.5 pt-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-colors ${
                      i <= strength.score ? strength.color : "bg-foreground/10"
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between">
                <p className="text-foreground/55 font-mono text-[11px] tracking-wider uppercase">
                  {strength.label}
                </p>
                <div className="flex items-center gap-1.5 text-xs">
                  {passphrase.length >= 8 ? (
                    <span className="text-brand inline-flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      8+ chars
                    </span>
                  ) : (
                    <span className="text-foreground/55 inline-flex items-center gap-1">
                      <X className="h-3 w-3" />
                      8+ chars
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="confirmPassphrase"
            className="text-foreground/80 text-xs font-medium tracking-wider uppercase"
          >
            {t("confirmPassphrase")}
          </Label>
          <Input
            id="confirmPassphrase"
            type="password"
            placeholder={t("passphraseConfirmPlaceholder")}
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            required
            disabled={isLoading}
            autoComplete="new-password"
            className={`h-12 rounded-xl ${confirmPassphrase && !passphrasesMatch ? "border-destructive" : ""}`}
          />
          {confirmPassphrase && !passphrasesMatch && (
            <p className="text-destructive inline-flex items-center gap-1 text-xs">
              <X className="h-3 w-3" />
              {t("passwordMismatch")}
            </p>
          )}
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
            t("creatingAccount")
          ) : (
            <>
              {t("register")}
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>

        <p className="text-foreground/50 text-center text-xs">
          By creating an account, you agree to our{" "}
          <Link
            href={ROUTES.LEGAL_TERMS}
            className="text-foreground/70 hover:text-foreground underline-offset-4 hover:underline"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            href={ROUTES.LEGAL_PRIVACY}
            className="text-foreground/70 hover:text-foreground underline-offset-4 hover:underline"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </form>

      {/* Backendless mode: no OAuth. Rendered as null, kept for layout parity. */}
      <OAuthBlock label={t("orSignUpWith")} variant="signup" />
    </div>
  );
}
