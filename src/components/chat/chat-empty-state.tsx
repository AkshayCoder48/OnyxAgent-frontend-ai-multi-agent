"use client";

import { ArrowUpRight, Code2, FileSearch, Globe, Sparkles, Wrench, Brain } from "lucide-react";

import { useAuth } from "@/hooks";

const PROMPTS = [
  {
    icon: Code2,
    title: "Write some code",
    prompt: "Write a Python function that hashes a password with bcrypt and verifies it.",
    color: "text-blue-500",
  },
  {
    icon: FileSearch,
    title: "Analyze files",
    prompt: "List all files in my workspace and summarize what each one does.",
    color: "text-emerald-500",
  },
  {
    icon: Globe,
    title: "Search the web",
    prompt: "Search the web for the latest news about AI agents and summarize the top 3 results.",
    color: "text-primary",
  },
  {
    icon: Brain,
    title: "Brainstorm ideas",
    prompt: "Give me 5 ideas for an onboarding email sequence for a developer tool.",
    color: "text-orange-500",
  },
];

const FEATURES = [
  { icon: Code2, label: "51 Tools" },
  { icon: Wrench, label: "Code Runner" },
  { icon: FileSearch, label: "File System" },
  { icon: Globe, label: "Web Search" },
  { icon: Brain, label: "Memory" },
  { icon: Sparkles, label: "Workflows" },
];

interface ChatEmptyStateProps {
  onPick: (prompt: string) => void;
}

export function ChatEmptyState({ onPick }: ChatEmptyStateProps) {
  const { user } = useAuth();
  const firstName = user?.full_name?.split(" ")[0] || user?.email?.split("@")[0];

  return (
    /* SCROLLER + m-auto CENTERING (mobile logo-visibility fix): the old
       `justify-center` + `overflow-y-auto` combination CLIPS THE TOP when
       the content is taller than the viewport — flex centering overflows
       equally above and below, but scrollTop starts at 0, so the "Welcome
       to OnyxAgent" logo sat above the unreachable region and was never
       visible on phones. With an auto-margin wrapper the content centers
       when it fits and scrolls FROM THE TOP when it doesn't. */
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto scrollbar-thin px-3 py-4 sm:px-4 sm:py-8">
      <div className="m-auto flex w-full flex-col items-center">
        {/* Title — "Welcome to" + decorated OnyxAgent logo text */}
        <h2 className="text-center text-xl font-bold tracking-tight sm:text-2xl md:text-3xl">
          {firstName ? (
            <>
              Welcome to{" "}
              <span className="onyx-logo-text text-xl sm:text-2xl md:text-3xl">
                <span className="onyx-logo-o">O</span>nyx<span className="onyx-logo-agent">Agent</span>
              </span>
              {`, ${firstName}`}
            </>
          ) : (
            <>
              Welcome to{" "}
              <span className="onyx-logo-text text-xl sm:text-2xl md:text-3xl">
                <span className="onyx-logo-o">O</span>nyx<span className="onyx-logo-agent">Agent</span>
              </span>
            </>
          )}
        </h2>

        {/* Subtitle */}
        <p className="mt-2 max-w-md text-center text-xs leading-relaxed text-muted-foreground sm:mt-3 sm:text-sm">
          Your AI-powered assistant with 51 tools, code execution, web search,
          file management, memory, and more. Start a conversation or pick a prompt below.
        </p>

        {/* Feature badges — compact on phones (part of the "other things
            are large" crowding that hid the logo). */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 sm:mt-6 sm:gap-2">
          {FEATURES.map((f) => (
            <div
              key={f.label}
              className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:px-3 sm:py-1 sm:text-xs"
            >
              <f.icon className="h-3 w-3" />
              {f.label}
            </div>
          ))}
        </div>

        {/* Prompt cards — single-line descriptions on phones so the four
            cards stay short; full two-line clamp from sm up. */}
        <div className="stagger-in mt-3 grid w-full grid-cols-1 gap-2 sm:mt-6 sm:grid-cols-2 sm:gap-3">
          {PROMPTS.map((p) => (
            <button
              key={p.title}
              onClick={() => onPick(p.prompt)}
              className="glass-card hover-lift ripple-tap mb-press group flex items-start gap-2.5 rounded-xl border border-border p-2.5 text-left sm:p-3.5 sm:gap-3"
            >
              <p.icon className={`mt-0.5 h-4 w-4 shrink-0 ${p.color} group-hover:scale-110 transition-transform`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{p.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1 sm:line-clamp-2">{p.prompt}</div>
              </div>
              <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-muted-foreground sm:mt-6 sm:text-xs">
          <span>Powered by Onyx AI Framework</span>
          <span>·</span>
          <span>Start chatting from the sidebar</span>
        </div>
      </div>
    </div>
  );
}
