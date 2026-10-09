"use client";

import { useEffect, useState } from "react";
import { notFound } from "next/navigation";
import {
  FileSearch as FileSearchIcon,
  PenLine as PenLineIcon,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import {
  AgentHandoff,
  AgentPlan,
  AgentStatus,
  ArtifactCard,
  CheckpointHistory,
  CodeDiff,
  FileTree,
  GenerationLoader,
  InlineCitation,
  DocumentReference,
  MemoryChips,
  MessagePair,
  Orb,
  renderGenerativeUI,
  styledGenerativeUILibrary,
  StreamingText,
  StoppedRun,
  SubagentList,
  ThinkingIndicator,
  ThinkingReasoning,
  Timeline,
  TodoList,
  ToolCall,
  ToolTimeline,
  type LatticeVariant,
  type MemoryChip,
  type TimelineEvent,
} from "@/components/assistant-ui/elements";

import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/states";
import { MessageItem } from "@/components/chat/message-item";
import { BrowserUseGroup } from "@/components/chat/tool-results/use-browser";
import { FilesFooter } from "@/components/chat/streaming-file-tree";
import { LivePageFrame } from "@/components/chat/tool-results/live-page-frame";
import type { ChatMessage, ToolCall as ToolCallData } from "@/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  FormField,
  IconButton,
  Input,
  ModelPicker,
  ReasoningText,
  SectionHeading,
  ShinyButton,
  ShinyButtonEmerald,
} from "@/components/ui";
import { defaultModelProviders } from "@/components/ui/model-picker";

/**
 * Dev-only component gallery — a lightweight stand-in for Storybook that keeps
 * the design system honest. Renders the core primitives in one place so visual
 * regressions are easy to spot. Hidden in production builds.
 */
export default function ComponentGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-card rounded-xl border p-5">
      <SectionHeading eyebrow="Primitive" title={title} className="mb-4" />
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}

function Gallery() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        eyebrow="Dev"
        title="Component gallery"
        description="Core design-system primitives, in one place."
      />

      <Section title="Streaming turn — unified panel + captions + companion cursor">
        <StreamingTurnPreview />
      </Section>

      <Section title="Chat surface — live web page preview · code-block Save · brand-aware inline code">
        <ChatSurfacePreview />
      </Section>

      <Section title="Button variants">
        {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </Section>

      <Section title="Button sizes">
        <Button size="sm">sm</Button>
        <Button size="default">default</Button>
        <Button size="lg">lg</Button>
        <IconButton aria-label="Sparkles" size="icon-sm">
          <Sparkles />
        </IconButton>
        <IconButton aria-label="Delete" size="icon">
          <Trash2 />
        </IconButton>
      </Section>

      <Section title="Shiny Buttons">
        {/* Gleam-edge, themed on-brand (cyan fill, light-cyan conic sweep,
            white shine, pill radius). */}
        <ShinyButton
          label="Get Started"
          fillColor="var(--color-primary)"
          labelColor="var(--color-primary-foreground)"
          accentColor="var(--color-brand-muted)"
          accentSoftColor="#ffffff"
          cornerRadius={999}
        />
        {/* Gleam-edge, the component's stock look (black fill, orange sweep). */}
        <ShinyButton label="Get Started" cornerRadius={999} />
        {/* The emerald shine sweep. */}
        <ShinyButtonEmerald>Emerald Shine</ShinyButtonEmerald>
      </Section>

      <Section title="ReasoningText (thinking variants)">
        {/* The pasted beui.dev loading-states component — phrase cycling
            with three transition variants. "auto" rotates cascade → swap →
            scramble as the phrases advance (same engine the live
            ThinkingIndicator now uses). */}
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] font-mono uppercase tracking-wider">
              auto (rotates all variants)
            </span>
            <ReasoningText variant="auto" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] font-mono uppercase tracking-wider">
              cascade
            </span>
            <ReasoningText variant="cascade" interval={1400} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] font-mono uppercase tracking-wider">
              swap
            </span>
            <ReasoningText variant="swap" interval={1400} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] font-mono uppercase tracking-wider">
              scramble
            </span>
            <ReasoningText variant="scramble" interval={1400} />
          </div>
        </div>
      </Section>

      <Section title="ModelPicker">
        {/* The pasted model picker — provider rail, capability chips,
            thinking-effort track and search, on the built-in demo data. */}
        <ModelPicker providers={defaultModelProviders} side="top" align="start" />
      </Section>

      <Section title="Badges">
        {(["default", "secondary", "outline", "destructive"] as const).map((v) => (
          <Badge key={v} variant={v}>
            {v}
          </Badge>
        ))}
      </Section>

      <Section title="Alerts">
        <div className="w-full space-y-2">
          {(["default", "warning", "destructive", "success"] as const).map((v) => (
            <Alert key={v} variant={v}>
              <AlertTitle>{v} alert</AlertTitle>
              <AlertDescription>Something worth the user&apos;s attention.</AlertDescription>
            </Alert>
          ))}
        </div>
      </Section>

      <Section title="FormField">
        <div className="w-full max-w-sm space-y-4">
          <FormField label="Display name" htmlFor="g-name" description="Visible to teammates.">
            <Input id="g-name" placeholder="Ada Lovelace" />
          </FormField>
          <FormField label="Email" htmlFor="g-email" error="That email is already taken." required>
            <Input id="g-email" type="email" defaultValue="taken@example.com" />
          </FormField>
        </div>
      </Section>

      <Section title="StatCard">
        <div className="grid w-full gap-3 sm:grid-cols-3">
          <StatCard label="Credits" value="1,240" delta={12.5} deltaLabel="vs prior 7d" />
          <StatCard label="Conversations" value="38" footer="across all chats" />
          <StatCard label="Knowledge base" value="0" unit="vectors" />
        </div>
      </Section>

      <Section title="EmptyState">
        <div className="w-full">
          <EmptyState
            icon={Sparkles}
            title="Nothing here yet"
            description="Create your first item to get started."
            cta={{ label: "Create", onClick: () => {} }}
          />
        </div>
      </Section>

      <Section title="ConfirmDialog">
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          Delete something…
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete this resource?"
          description="This action cannot be undone."
          destructive
          confirmText="DELETE"
          confirmLabel="Delete"
          onConfirm={() => setConfirmOpen(false)}
        />
      </Section>

      <AgentElementsShowcase />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Agent "elements" showcase — assistant-ui–style tool cards re-themed to the
 * Terra palette. Mirrors the live treatments used in chat for tool calls,
 * todos, reasoning, and streaming text.
 * ------------------------------------------------------------------------- */
function AgentElementsShowcase() {
  const [toolOpen, setToolOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [currentId, setCurrentId] = useState("3");
  const [citationOpen, setCitationOpen] = useState<number | null>(null);
  const [activePage, setActivePage] = useState(4);
  const [chips, setChips] = useState<MemoryChip[]>([
    { id: "1", text: "Prefers TypeScript", change: "existing" },
    { id: "2", text: "Works in a pnpm monorepo", change: "existing" },
    { id: "3", text: "Ships with changesets", change: "added" },
  ]);

  return (
    <Section title="Agent elements (tool cards)">
      <div className="grid w-full max-w-3xl gap-5">
        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Tool call + tool timeline</p>
          <ToolCall
            label="Searched the docs"
            activeLabel="Searching the docs"
            query="draft persistence"
            request='{"query": "draft persistence"}'
            result="3 matches, best hit /docs/runtime/drafts"
            running={false}
            open={toolOpen}
            onOpenChange={setToolOpen}
          />
          <ToolTimeline
            steps={[
              { verb: "Read", chip: "thread.tsx", icon: FileSearchIcon },
              { verb: "Ran", chip: "pnpm vitest", icon: TerminalIcon },
              { verb: "Edited", chip: "composer.tsx", icon: PenLineIcon },
            ]}
            visibleSteps={3}
            streaming={false}
            open={timelineOpen}
            onOpenChange={setTimelineOpen}
            restingLabel="3 steps · 1 file changed"
            activeLabel="Working"
            stats={[{ file: "composer.tsx", added: 14, removed: 3 }]}
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Use Browser — unified tool-call UI (settled run)</p>
          <BrowserToolPreview />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Live page frame — blocked embedding + unreachable fallbacks</p>
          {/* github.com sends X-Frame-Options: deny — the frame-check guard
              auto-switches to the reader snapshot (never the browser's
              "refused to connect" error page). */}
          <LivePageFrame
            url="https://github.com"
            title="GitHub"
            badge="Web Page"
            heightClass="h-64"
          />
          {/* Unreachable host — the honest "Site not accessible" card with
              retry + new-tab escape. */}
          <LivePageFrame
            url="https://onyx-frame-check-test.invalid"
            badge="Web Page"
            heightClass="h-48"
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Code diff + file tree</p>
          <CodeDiff
            filename="composer.tsx"
            additions={2}
            deletions={1}
            cycle={0}
            lines={[
              { kind: "context", text: "export function Composer() {" },
              { kind: "removed", text: '  const [draft, setDraft] = useState("");' },
              { kind: "added", text: "  const draft = useDraft(threadId);" },
            ]}
          />
          <FileTree
            nodes={[
              { path: "core", name: "packages/core/src", depth: 0, kind: "folder" },
              { path: "core/convert", name: "convertMessages.ts", depth: 1, kind: "file", additions: 24, deletions: 6 },
              { path: "core/test", name: "convertMessages.test.ts", depth: 1, kind: "file", additions: 41 },
              { path: "changeset", name: ".changeset/tidy-pans-shave.md", depth: 0, kind: "file", additions: 5 },
            ]}
            visibleCount={4}
            totalAdditions={70}
            totalDeletions={6}
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Files footer — Uiverse tree (guide lines, folder glyph swap)</p>
          <FilesFooter
            nodes={[
              {
                id: "src",
                label: "src",
                icon: "folder",
                children: [
                  {
                    id: "src/app",
                    label: "app",
                    icon: "folder",
                    children: [
                      { id: "src/app/layout.tsx", label: "layout.tsx", icon: "file-code", description: "+12" },
                      { id: "src/app/page.tsx", label: "page.tsx", icon: "file-code", description: "+48 −3" },
                    ],
                  },
                  {
                    id: "src/components",
                    label: "components",
                    icon: "folder",
                    children: [
                      {
                        id: "src/components/ui",
                        label: "ui",
                        icon: "folder",
                        children: [
                          { id: "src/components/ui/button.tsx", label: "button.tsx", icon: "file-code", description: "+27" },
                        ],
                      },
                      { id: "src/components/header.tsx", label: "header.tsx", icon: "file-code", description: "+9 −1" },
                      { id: "src/components/footer.tsx", label: "footer.tsx", icon: "file-code", description: "+6" },
                    ],
                  },
                  {
                    id: "src/lib",
                    label: "lib",
                    icon: "folder",
                    children: [
                      { id: "src/lib/utils.ts", label: "utils.ts", icon: "file-code", description: "+3" },
                    ],
                  },
                ],
              },
            ]}
            fileCount={7}
            totalAdditions={105}
            totalDeletions={4}
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Agent plan + subagent list + status</p>
          <AgentPlan
            steps={[
              "Read existing composer state",
              "Design the draft store",
              "Wire runtime persistence",
              "Add regression tests",
            ]}
            activeIndex={2}
          />
          <SubagentList
            agents={[
              { name: "Explore the runtime", model: "haiku" },
              { name: "Fix composer types", model: "sonnet" },
              { name: "Write regression tests", model: "sonnet" },
            ]}
            completedCount={2}
            progress={[100, 100, 45]}
            showSummary
            summaryAgent={{ name: "Summarize findings", model: "haiku" }}
          />
          <div className="flex flex-wrap gap-2">
            <AgentStatus state="working" label="Refactoring composer" elapsed="0:04" />
            <AgentStatus state="waiting" label="Waiting for approval" elapsed="3s" />
            <AgentStatus state="done" label="Finished, 2 files changed" />
          </div>
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Artifact + todo + handoff + checkpoints</p>
          <ArtifactCard title="Draft persistence RFC" meta="Document · v3 · just now" />
          <TodoList
            revision={2}
            items={[
              { id: "1", text: "Read the failing test", status: "done" },
              { id: "2", text: "Fix the converter", status: "active" },
              { id: "3", text: "Re-run the suite", status: "pending" },
            ]}
          />
          <AgentHandoff
            from="Router"
            to="Billing"
            reason="Question is about a refund, not routing."
            carried={["order #48213", "customer tier: pro"]}
            settled={false}
          />
          <CheckpointHistory
            checkpoints={[
              { id: "1", label: "Initial scaffold", at: "10:02", files: 4 },
              { id: "2", label: "Added auth", at: "10:19", files: 7 },
              { id: "3", label: "Fixed layout bug", at: "10:41", files: 2 },
            ]}
            currentId={currentId}
            onRestore={setCurrentId}
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Loader + streaming text + stopped run</p>
          <LoaderPreview />
          <StreamingText
            segments={[
              { text: "The response streams in as" },
              { text: "useAuiState", mono: true },
              { text: "resolves each part." },
            ]}
            count={7}
            streaming
          />
          <MessagePair
            userMessage="What's the capital of France?"
            words={["Paris", "is", "the", "capital", "of", "France."]}
            visibleWords={6}
            streaming={false}
          />
          <StoppedRun
            words={["The", "composer", "reads", "the", "draft"]}
            reason="stopped by you"
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Inline citation + document reference + memory</p>
          <div className="relative">
            <InlineCitation
              sources={[
                {
                  domain: "assistant-ui.com",
                  title: "Optimistic updates in the runtime",
                  snippet:
                    "The runtime applies local edits immediately and reconciles them once the server acknowledges the write.",
                },
                {
                  domain: "react.dev",
                  title: "useSyncExternalStore reference",
                  snippet:
                    "Subscribes a component to an external store, re-rendering on every store change with a consistent snapshot.",
                },
              ]}
              openIndex={citationOpen}
              onOpenIndexChange={setCitationOpen}
            />
          </div>
          <DocumentReference
            title="migration-0.14.md"
            pages={12}
            activePage={activePage}
            onJump={setActivePage}
            anchors={[
              { page: 4, quote: "The composer owns its draft; parent state that mirrored it is no longer read." },
              { page: 9, quote: "Each thread keeps its own slot, cleared on switch rather than reused." },
              { page: 4, quote: "Reloading a message creates a sibling branch automatically." },
            ]}
          />
          <MemoryChips
            chips={chips}
            onForget={(id) => setChips((c) => c.filter((chip) => chip.id !== id))}
          />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Timeline + generative UI</p>
          <TimelinePreview />
          {renderGenerativeUI(
            {
              $type: "Card",
              title: "Release notes",
              children: [
                { $type: "Markdown", value: "**Revenue** is up 12% this quarter." },
                {
                  $type: "List",
                  children: [
                    { $type: "ListItem", children: "Composer drafts now persist per thread" },
                    { $type: "ListItem", children: "Tool calls stream partial arguments" },
                  ],
                },
                { $type: "Callout", value: "Drafts migrate on first read; nothing to run by hand." },
              ],
            },
            styledGenerativeUILibrary,
          )}
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Orb lattice — all 25 variants</p>
          <OrbGrid />
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Thinking indicator + thinking reasoning + orbs</p>
          <ThinkingIndicator label="Reading thread.tsx" elapsed="12s" />
          <ThinkingReasoning
            sentences={[
              "Reading the request and the current selection, then locating the jwt.verify call inside the auth middleware.",
              "The verify call sets no algorithms allowlist, so a token signed with 'none' or a weak cipher could be accepted.",
              "Tracing where the signing secret is loaded from and confirming it is never logged or sent back to the client.",
              "Planning to pin the algorithm to HS256 and to validate the issuer and audience claims on every incoming request.",
              "Scanning the existing tests around the middleware so the fix stays covered and nothing downstream regresses.",
            ]}
            phase="done"
            elapsedSeconds={5}
          />
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <Orb variant="S1" />
            <Orb variant="S2" />
            <Orb variant="S3" />
            <Orb variant="S4" />
            <Orb variant="S5" />
            <Orb variant="S1" label="Working" pill />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Small interactive ticking loader for the gallery. */
function LoaderPreview() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);
  return <GenerationLoader label="Generating" tick={tick} />;
}

/** Use Browser — the unified tool-call surface (Browser-Tool Reliability
 * PRD §8): a settled run of consecutive use_browser calls rendered as one
 * compact, technical, collapsible tool line. Mock payloads mirror the
 * driver's wire shapes. */
function BrowserToolPreview() {
  // Static mock clock — impure calls (Date.now) are banned during render.
  const t = 1_760_000_000_000;
  const mk = (
    id: string,
    action: string,
    args: Record<string, unknown>,
    result: unknown,
    status: ToolCallData["status"] = "completed",
    dur = 900,
  ): ToolCallData => ({
    id,
    name: "use_browser",
    args: { action, ...args },
    result,
    status,
    startedAt: t - 30_000,
    endedAt: t - 30_000 + dur,
  });
  const calls: ToolCallData[] = [
    mk("b1", "navigate", { url: "https://example.com" }, {
      kind: "browser", success: true, action: "navigate", status: 200,
      url: "https://example.com", title: "Example Domain",
      viewport: { width: 1280, height: 800 },
    }),
    mk("b2", "snapshot", {}, {
      kind: "browser", success: true, action: "snapshot", count: 2,
      url: "https://example.com", title: "Example Domain",
      elements: [
        { ref: "e1", tag: "a", role: "link", text: "More information...", selector: "a" },
        { ref: "e2", tag: "input", text: null, selector: "input[type=search]" },
      ],
      forms: [{ tag: "input", type: "search", label: "Search", value: "" }],
    }, "completed", 1400),
    mk("b3", "click", { target: { role: "link", name: "More information..." } }, {
      kind: "browser", success: true, action: "click",
      url: "https://example.com", title: "Example Domain",
    }, "completed", 600),
    mk("b4", "screen_record", { operation: "stop" }, {
      kind: "browser", success: true, action: "screen_record", operation: "stop",
      file: "/home/user/.onyx/browser/recordings/recording-1760.json.mp4",
      name: "recording-1760.mp4", frames: 48, durationSec: 24, sizeBytes: 1_572_864,
    }, "completed", 5200),
    mk("b5", "evaluate", { code: "document.title" }, {
      kind: "browser", success: false, action: "evaluate",
      error: { type: "evaluation_failed", message: "Page context destroyed during navigation", recoverable: true },
    }, "error", 300),
  ];
  return (
    <div className="w-full max-w-xl rounded-xl border border-border bg-secondary/40 p-3">
      <BrowserUseGroup toolCalls={calls} />
    </div>
  );
}

/** Timeline preview — events revealed on a timer, past/now/future. */
const GALLERY_EVENTS: readonly TimelineEvent[] = [
  { id: "1", when: "past", time: "09:02", title: "Issue filed", detail: "Draft survives a thread switch" },
  { id: "2", when: "past", time: "09:40", title: "Reproduced" },
  { id: "3", when: "now", time: "10:15", title: "Fix in review", detail: "Clears the slot on switch" },
  { id: "4", when: "future", time: "11:00", title: "Release 0.14.1" },
];

function TimelinePreview() {
  const [visibleCount, setVisibleCount] = useState(0);
  useEffect(() => {
    if (visibleCount >= GALLERY_EVENTS.length) return;
    const id = setTimeout(() => setVisibleCount((n) => n + 1), 600);
    return () => clearTimeout(id);
  }, [visibleCount]);
  return <Timeline events={GALLERY_EVENTS} visibleCount={visibleCount} />;
}

/** Every orb variant, one grid — S/G/C/B/M families × 5. */
const ORB_VARIANTS: readonly LatticeVariant[] = [
  "S1", "S2", "S3", "S4", "S5",
  "G1", "G2", "G3", "G4", "G5",
  "C1", "C2", "C3", "C4", "C5",
  "B1", "B2", "B3", "B4", "B5",
  "M1", "M2", "M3", "M4", "M5",
];

function OrbGrid() {
  return (
    <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
      {ORB_VARIANTS.map((v) => (
        <div key={v} className="flex flex-col items-center gap-1.5">
          <Orb variant={v} size={18} />
          <span className="font-mono text-[9px] tabular-nums text-muted-foreground">{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * STREAMING TURN PREVIEW — mounts the REAL MessageItem with synthetic
 * messages so the unified collapsible panel, the live status captions, the
 * persistent thinking circle and the companion cursor can be eyeballed
 * without a provider. Stages follow a real turn's life:
 *   thinking → browsing (tool) → writing → settled.
 * ─────────────────────────────────────────────────────────────────────────── */
const TURN_STAGES = ["thinking", "browsing", "writing", "settled"] as const;
type TurnStage = (typeof TURN_STAGES)[number];

const STAGE_LABEL: Record<TurnStage, string> = {
  thinking: "1 · Thinking (tool-less, circle + caption)",
  browsing: "2 · Browsing (tool turn, generated caption)",
  writing: "3 · Writing (answer streams with companion cursor)",
  settled: "4 · Settled (no tools → stays expanded)",
};

function synthMessage(
  parts: import("@/types").MessagePart[],
  isStreaming: boolean,
  now: number,
): ChatMessage {
  return {
    id: "synthetic-turn",
    role: "assistant",
    content: "",
    timestamp: new Date(now),
    isStreaming,
    parts,
  };
}

function StreamingTurnPreview() {
  const [stage, setStage] = useState<TurnStage>("thinking");
  // Synthetic clock — captured ONCE per mount via the lazy initializer (an
  // impure call inside the initializer is fine; calling Date.now() in the
  // render body trips the React-Compiler purity rule).
  const [now] = useState(() => Date.now());

  const thinkingRun = (open: boolean, text: string) => ({
    id: "p-think",
    type: "thinking" as const,
    content: text,
    round: 1,
    roundStartedAt: now - 5200,
    ...(open ? {} : { reasoningEndedAt: now - 3000 }),
  });

  const browserCall = (status: "running" | "completed") => ({
    id: "tc-browser",
    name: "use_browser",
    args: { action: "navigate", url: "https://perchance.org/" } as Record<string, unknown>,
    status,
    startedAt: now - 2800,
    ...(status === "completed"
      ? {
          endedAt: now - 1200,
          result: {
            kind: "browser",
            action: "navigate",
            ok: true,
            url: "https://perchance.org/",
            title: "perchance.org — random generators",
          },
        }
      : {}),
  });

  const message = (() => {
    if (stage === "thinking") {
      return synthMessage(
        [
          thinkingRun(true, "The user wants an interactive tour of perchance.org."),
          {
            id: "p-think-2",
            type: "thinking" as const,
            content:
              "I'll open the site in the sandbox browser, walk the homepage, and summarize what the platform offers.",
            round: 1,
            roundStartedAt: now - 5200,
          },
        ],
        true,
        now,
      );
    }
    if (stage === "browsing") {
      return synthMessage(
        [
          {
            ...thinkingRun(false, "Opening perchance.org in the sandbox browser to explore it interactively."),
            id: "p-think",
          },
          { id: "p-tool", type: "tool" as const, toolCall: browserCall("running"), round: 2, roundStartedAt: now - 2800 },
        ],
        true,
        now,
      );
    }
    if (stage === "writing") {
      return synthMessage(
        [
          {
            ...thinkingRun(false, "The site is a random-generator platform. Now writing the summary."),
            id: "p-think",
          },
          {
            id: "p-tool",
            type: "tool" as const,
            toolCall: browserCall("completed"),
            round: 2,
            roundStartedAt: now - 2800,
            roundEndedAt: now - 1200,
          },
          {
            id: "p-text",
            type: "text" as const,
            content:
              "Here's what I found on **perchance.org** — it's a free platform for building and sharing random text generators",
            round: 3,
          },
        ],
        true,
        now,
      );
    }
    // settled — tool-less turn: panel rests EXPANDED with "Thought Ns"
    return synthMessage(
      [
        {
          ...thinkingRun(false, "Answering directly from what I already know about the platform."),
          id: "p-think",
          roundStartedAt: now - 5200,
          roundEndedAt: now - 200,
        },
        {
          id: "p-text",
          type: "text" as const,
          content:
            "perchance.org is a free platform for creating and sharing random generators — no signup needed.",
          round: 2,
        },
      ],
      false,
      now,
    );
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {TURN_STAGES.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === stage ? "default" : "outline"}
            onClick={() => setStage(s)}
          >
            {STAGE_LABEL[s]}
          </Button>
        ))}
      </div>
      {/* The REAL chat renderer — same component the thread uses. */}
      <div className="rounded-xl border border-border/60 bg-background/50 p-3">
        <MessageItem message={message} />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * CHAT SURFACE PREVIEW — mounts the REAL MessageItem with a settled
 * web_fetch tool call + a markdown answer, so the chat surfaces are
 * verifiable without a provider:
 *   1. web_fetch → the "Show page preview" disclosure: enlarging the tool
 *      call reveals the LIVE page preview (sandboxed iframe, optional
 *      interactivity, extracted-text fallback) — never always-on;
 *   2. the message-action row → copy (check + emerald), rate (fills in),
 *      regenerate (spins), more (Quote / Copy as Markdown);
 *   3. the fenced code block → the Save-to-Files button (location /
 *      name / extension dialog) next to Copy;
 *   4. inline `code` → the brand-aware chip (follows Settings →
 *      Appearance, never a hardcoded cyan).
 * ─────────────────────────────────────────────────────────────────────── */
function ChatSurfacePreview() {
  const [now] = useState(() => Date.now());
  const message: ChatMessage = {
    id: "synthetic-chat-surface",
    role: "assistant",
    content: "",
    timestamp: new Date(now),
    isStreaming: false,
    parts: [
      {
        id: "p-webfetch",
        type: "tool" as const,
        round: 1,
        roundStartedAt: now - 4000,
        roundEndedAt: now - 2400,
        toolCall: {
          id: "tc-webfetch",
          name: "web_fetch",
          args: { url: "https://example.com" } as Record<string, unknown>,
          status: "completed",
          startedAt: now - 4000,
          endedAt: now - 2400,
          result: {
            url: "https://example.com",
            title: "Example Domain",
            content:
              "Example Domain. This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking permission. More information…",
            length: 178,
          },
        },
      },
      {
        id: "p-answer",
        type: "text" as const,
        round: 2,
        content: [
          "Here's the page — enlarge the **Web page** tool call above (or its “Show page preview” toggle) to see the real live site:",
          "",
          "A quick helper for it, with inline `fetch_page()` code:",
          "",
          "```python",
          "import urllib.request",
          "",
          'def fetch_page(url: str) -> str:',
          '    """Fetch a page and return its text."""',
          "    with urllib.request.urlopen(url, timeout=30) as r:",
          '        return r.read().decode("utf-8", errors="replace")',
          "```",
        ].join("\n"),
      },
    ],
  };
  return (
    <div className="rounded-xl border border-border/60 bg-background/50 p-3">
      <MessageItem message={message} />
    </div>
  );
}
