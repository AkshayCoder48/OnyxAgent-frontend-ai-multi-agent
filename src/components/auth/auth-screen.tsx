"use client";

import * as React from "react";
import { Bot, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const APP_NAME = "Agent Chat";
const PASSPHRASE_MIN = 8;

function isEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function AuthScreen() {
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const storeError = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [tab, setTab] = React.useState<"signin" | "signup">("signin");
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [showPass, setShowPass] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  // Reset transient errors whenever the tab or any field changes.
  React.useEffect(() => {
    clearError();
    setLocalError(null);
  }, [tab, clearError]);

  React.useEffect(() => {
    setLocalError(null);
    clearError();
  }, [email, fullName, passphrase, clearError]);

  const error = localError ?? storeError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const emailTrim = email.trim();
    if (!isEmail(emailTrim)) {
      setLocalError("Please enter a valid email address.");
      return;
    }
    if (!passphrase) {
      setLocalError("Passphrase is required.");
      return;
    }
    if (tab === "signup" && passphrase.length < PASSPHRASE_MIN) {
      setLocalError(`Passphrase must be at least ${PASSPHRASE_MIN} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      if (tab === "signin") {
        await login(emailTrim, passphrase);
      } else {
        await register(emailTrim, fullName.trim(), passphrase);
      }
      // On success, the parent AppShell swaps to onboarding/dashboard.
    } catch {
      // The auth store already captured the error message.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-primary text-primary-foreground mb-3 flex size-12 items-center justify-center rounded-xl">
            <Bot className="size-7" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Your private, local-first AI agent workspace.
          </p>
        </div>

        <Card>
          <CardHeader>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "signin" | "signup")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign In</TabsTrigger>
                <TabsTrigger value="signup">Create Account</TabsTrigger>
              </TabsList>

              <TabsContent value="signin" className="mt-6">
                <CardTitle className="text-lg">Welcome back</CardTitle>
                <CardDescription>
                  Enter your email and passphrase to unlock your local vault.
                </CardDescription>
              </TabsContent>
              <TabsContent value="signup" className="mt-6">
                <CardTitle className="text-lg">Create your local account</CardTitle>
                <CardDescription>
                  Choose a passphrase to encrypt your data. There is no server &mdash;
                  it never leaves this browser.
                </CardDescription>
              </TabsContent>
            </Tabs>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="grid gap-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={submitting}
                />
              </div>

              {tab === "signup" && (
                <div className="grid gap-2">
                  <Label htmlFor="fullName">Full name (optional)</Label>
                  <Input
                    id="fullName"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={submitting}
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="passphrase">Passphrase</Label>
                <div className="relative">
                  <Input
                    id="passphrase"
                    type={showPass ? "text" : "password"}
                    autoComplete={tab === "signin" ? "current-password" : "new-password"}
                    placeholder={
                      tab === "signin" ? "Your passphrase" : "At least 8 characters"
                    }
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    required
                    disabled={submitting}
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    tabIndex={-1}
                    aria-label={showPass ? "Hide passphrase" : "Show passphrase"}
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute inset-y-0 right-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                  >
                    {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                {tab === "signup" && (
                  <p className="text-muted-foreground text-xs">
                    This passphrase encrypts your vault (PBKDF2 + AES-GCM). It cannot be
                    recovered &mdash; store it somewhere safe.
                  </p>
                )}
              </div>
            </CardContent>

            <CardFooter className="mt-2 flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {tab === "signin" ? "Unlock vault" : "Create account"}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Local-first notice */}
        <div className="text-muted-foreground mt-4 flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            Your data is stored locally in your browser. No server. No account required.
          </span>
        </div>

        {/* Footer / explainer */}
        <div className="mt-6">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="how" className="border-b-0">
              <AccordionTrigger className="text-muted-foreground hover:no-underline text-xs">
                How does this work?
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-xs leading-relaxed">
                <p className="mb-2">
                  Agent Chat is <strong>backendless</strong>: there is no email
                  verification, no OAuth, and no JWT. Instead, your passphrase is run
                  through PBKDF2 (250,000 iterations) to derive an AES-GCM key. That key
                  encrypts a known plaintext we store alongside a per-user salt &mdash;
                  when you sign in, we re-derive the key and try to decrypt it. If it
                  matches, your passphrase is correct and the vault is unlocked.
                </p>
                <p className="mb-2">
                  Everything &mdash; conversations, AI provider keys, settings &mdash;
                  lives in your browser&apos;s IndexedDB and is encrypted at rest with
                  that derived key. The key itself is held only in memory for the
                  duration of your session and is wiped when you log out or close the
                  tab.
                </p>
                <p>
                  Because nothing is ever transmitted, there is no password reset: if you
                  forget your passphrase, your encrypted data becomes unreadable. Choose
                  a strong, memorable passphrase.
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    </div>
  );
}

export default AuthScreen;
