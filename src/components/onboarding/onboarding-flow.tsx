"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  PartyPopper,
  Plug,
  Sparkles,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { useProviders, useSettings } from "@/hooks/use-data";
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
import { cn } from "@/lib/utils";

type StepId = "welcome" | "provider" | "hopx" | "done";

interface StepMeta {
  id: StepId;
  title: string;
  subtitle: string;
}

const STEPS: StepMeta[] = [
  { id: "welcome", title: "Welcome", subtitle: "Let's get started" },
  { id: "provider", title: "AI Provider", subtitle: "Add your first key" },
  { id: "hopx", title: "Hopx Key", subtitle: "Optional sandbox tools" },
  { id: "done", title: "Done", subtitle: "Start chatting" },
];

function isUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function OnboardingFlow() {
  const completeOnboarding = useAuthStore((s) => s.completeOnboarding);
  const user = useAuthStore((s) => s.user);
  const { create: createProvider } = useProviders();
  const { setHopxKey: saveHopxKey } = useSettings();

  const [stepIdx, setStepIdx] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  // ---- Step 2 (provider) state ----
  const [provName, setProvName] = React.useState("OpenAI");
  const [provBaseUrl, setProvBaseUrl] = React.useState("https://api.openai.com");
  const [provApiKey, setProvApiKey] = React.useState("");
  const [provModel, setProvModel] = React.useState("gpt-4.1-mini");

  // ---- Step 3 (hopx) state ----
  const [hopxKey, setHopxKey] = React.useState("");

  const current = STEPS[stepIdx];

  function goNext() {
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1));
  }
  function goBack() {
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  async function handleWelcomeNext() {
    goNext();
  }

  async function handleProviderNext(skip: boolean) {
    if (skip) {
      toast.info("Skipped — you can add a provider later in Settings.");
      goNext();
      return;
    }
    if (!provName.trim()) {
      toast.error("Provider name is required.");
      return;
    }
    if (!isUrl(provBaseUrl.trim())) {
      toast.error("Base URL must be a valid http(s) URL.");
      return;
    }
    if (!provApiKey.trim()) {
      toast.error("API key is required.");
      return;
    }
    if (!provModel.trim()) {
      toast.error("Default model is required.");
      return;
    }
    setBusy(true);
    try {
      await createProvider({
        name: provName.trim(),
        base_url: provBaseUrl.trim().replace(/\/$/, ""),
        api_key: provApiKey.trim(),
        models: [provModel.trim()],
        model_type: "chat",
        tools_enabled: true,
        is_active: true,
      });
      toast.success("AI provider saved.");
      goNext();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save provider.");
    } finally {
      setBusy(false);
    }
  }

  async function handleHopxNext(skip: boolean) {
    if (skip || !hopxKey.trim()) {
      if (skip) toast.info("Skipped — you can add a Hopx key later in Settings.");
      goNext();
      return;
    }
    setBusy(true);
    try {
      await saveHopxKey(hopxKey.trim());
      toast.success("Hopx API key saved.");
      goNext();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save Hopx key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDone() {
    setBusy(true);
    try {
      await completeOnboarding();
      toast.success("Onboarding complete!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to finish onboarding.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center px-4 py-8">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-primary text-primary-foreground mb-3 flex size-11 items-center justify-center rounded-xl">
            <Bot className="size-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Agent Chat</h1>
          {user?.email && (
            <p className="text-muted-foreground mt-1 text-xs">Signed in as {user.email}</p>
          )}
        </div>

        {/* Stepper */}
        <Stepper steps={STEPS} currentIndex={stepIdx} />

        {/* Step body */}
        <Card className="mt-6">
          {current.id === "welcome" && (
            <WelcomeStep onNext={handleWelcomeNext} />
          )}

          {current.id === "provider" && (
            <ProviderStep
              name={provName}
              baseUrl={provBaseUrl}
              apiKey={provApiKey}
              model={provModel}
              busy={busy}
              onName={setProvName}
              onBaseUrl={setProvBaseUrl}
              onApiKey={setProvApiKey}
              onModel={setProvModel}
              onBack={goBack}
              onNext={() => handleProviderNext(false)}
              onSkip={() => handleProviderNext(true)}
            />
          )}

          {current.id === "hopx" && (
            <HopxStep
              apiKey={hopxKey}
              busy={busy}
              onApiKey={setHopxKey}
              onBack={goBack}
              onNext={() => handleHopxNext(false)}
              onSkip={() => handleHopxNext(true)}
            />
          )}

          {current.id === "done" && (
            <DoneStep busy={busy} onBack={goBack} onFinish={handleDone} />
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------
function Stepper({ steps, currentIndex }: { steps: StepMeta[]; currentIndex: number }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((s, i) => {
        const isDone = i < currentIndex;
        const isActive = i === currentIndex;
        return (
          <li key={s.id} className="flex flex-1 items-center gap-2">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                  isDone && "bg-primary text-primary-foreground border-primary",
                  isActive && "bg-card text-foreground border-foreground",
                  !isDone && !isActive && "bg-card text-muted-foreground border-border",
                )}
                aria-current={isActive ? "step" : undefined}
              >
                {isDone ? <Check className="size-4" /> : i + 1}
              </div>
              <span
                className={cn(
                  "hidden text-[11px] font-medium sm:block",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {s.title}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 transition-colors",
                  i < currentIndex ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------
function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <CardHeader>
        <div className="bg-secondary text-secondary-foreground mb-2 flex size-10 items-center justify-center rounded-lg">
          <Sparkles className="size-5" />
        </div>
        <CardTitle className="text-lg">Welcome to Agent Chat!</CardTitle>
        <CardDescription>Let&apos;s get you set up in a few quick steps.</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm leading-relaxed">
        <p className="mb-3">
          Agent Chat is a local-first AI workspace. Your conversations, keys, and
          settings are encrypted and stored only in this browser &mdash; nothing is ever
          sent to a server.
        </p>
        <p>
          Over the next two steps you can optionally connect an AI provider (so the agent
          can answer) and a Hopx API key (to enable code execution and file sandbox
          tools). You can skip either and configure them later from Settings.
        </p>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={onNext}>
          Next
          <ArrowRight className="size-4" />
        </Button>
      </CardFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — AI Provider
// ---------------------------------------------------------------------------
interface ProviderStepProps {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  busy: boolean;
  onName: (v: string) => void;
  onBaseUrl: (v: string) => void;
  onApiKey: (v: string) => void;
  onModel: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

function ProviderStep(props: ProviderStepProps) {
  return (
    <>
      <CardHeader>
        <div className="bg-secondary text-secondary-foreground mb-2 flex size-10 items-center justify-center rounded-lg">
          <Plug className="size-5" />
        </div>
        <CardTitle className="text-lg">Add an AI provider</CardTitle>
        <CardDescription>
          Bring your own key. We&apos;ve pre-filled OpenAI defaults &mdash; adjust to
          match your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="prov-name">Provider name</Label>
          <Input
            id="prov-name"
            value={props.name}
            onChange={(e) => props.onName(e.target.value)}
            placeholder="OpenAI"
            disabled={props.busy}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="prov-base">Base URL</Label>
          <Input
            id="prov-base"
            value={props.baseUrl}
            onChange={(e) => props.onBaseUrl(e.target.value)}
            placeholder="https://api.openai.com"
            disabled={props.busy}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="prov-key">API key</Label>
          <Input
            id="prov-key"
            type="password"
            value={props.apiKey}
            onChange={(e) => props.onApiKey(e.target.value)}
            placeholder="sk-..."
            disabled={props.busy}
            autoComplete="off"
          />
          <p className="text-muted-foreground text-xs">
            Encrypted with your vault key before being stored. Never leaves this browser.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="prov-model">Default model</Label>
          <Input
            id="prov-model"
            value={props.model}
            onChange={(e) => props.onModel(e.target.value)}
            placeholder="gpt-4.1-mini"
            disabled={props.busy}
          />
        </div>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" onClick={props.onBack} disabled={props.busy}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={props.onSkip} disabled={props.busy}>
            Skip
          </Button>
          <Button onClick={props.onNext} disabled={props.busy}>
            {props.busy && <Loader2 className="size-4 animate-spin" />}
            Save &amp; continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CardFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Hopx key
// ---------------------------------------------------------------------------
interface HopxStepProps {
  apiKey: string;
  busy: boolean;
  onApiKey: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

function HopxStep(props: HopxStepProps) {
  return (
    <>
      <CardHeader>
        <div className="bg-secondary text-secondary-foreground mb-2 flex size-10 items-center justify-center rounded-lg">
          <KeyRound className="size-5" />
        </div>
        <CardTitle className="text-lg">Add a Hopx API key (optional)</CardTitle>
        <CardDescription>
          Enables code execution, terminal, and file sandbox tools for the agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Alert>
          <AlertDescription>
            Without a Hopx key the agent still works for plain chat &mdash; it just
            can&apos;t run code or scripts in a sandbox. You can add one anytime in
            Settings.
          </AlertDescription>
        </Alert>
        <div className="grid gap-2">
          <Label htmlFor="hopx-key">Hopx API key</Label>
          <Input
            id="hopx-key"
            type="password"
            value={props.apiKey}
            onChange={(e) => props.onApiKey(e.target.value)}
            placeholder="hopx-..."
            disabled={props.busy}
            autoComplete="off"
          />
        </div>
        <a
          href="https://hopx.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline inline-flex items-center gap-1 text-xs"
        >
          Get a Hopx API key
          <ExternalLink className="size-3" />
        </a>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" onClick={props.onBack} disabled={props.busy}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={props.onSkip} disabled={props.busy}>
            Skip
          </Button>
          <Button onClick={props.onNext} disabled={props.busy}>
            {props.busy && <Loader2 className="size-4 animate-spin" />}
            Save &amp; continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CardFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Done
// ---------------------------------------------------------------------------
function DoneStep({
  busy,
  onBack,
  onFinish,
}: {
  busy: boolean;
  onBack: () => void;
  onFinish: () => void;
}) {
  return (
    <>
      <CardHeader>
        <div className="bg-secondary text-secondary-foreground mb-2 flex size-10 items-center justify-center rounded-lg">
          <PartyPopper className="size-5" />
        </div>
        <CardTitle className="text-lg">You&apos;re all set!</CardTitle>
        <CardDescription>
          Your local vault is ready. Start a conversation and put your agent to work.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm leading-relaxed">
        <p>
          Everything you create from here is encrypted and stored only in this browser.
          You can change providers, keys, and preferences any time from Settings.
        </p>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button onClick={onFinish} disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Start chatting
          <ArrowRight className="size-4" />
        </Button>
      </CardFooter>
    </>
  );
}

export default OnboardingFlow;
