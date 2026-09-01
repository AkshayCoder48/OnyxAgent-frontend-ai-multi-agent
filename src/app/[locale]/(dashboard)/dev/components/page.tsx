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
  MessagePair,
  Orb,
  StreamingText,
  StoppedRun,
  SubagentList,
  ThinkingIndicator,
  ThinkingReasoning,
  TodoList,
  ToolCall,
  ToolTimeline,
} from "@/components/assistant-ui/elements";

import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/states";
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
  SectionHeading,
} from "@/components/ui";

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
