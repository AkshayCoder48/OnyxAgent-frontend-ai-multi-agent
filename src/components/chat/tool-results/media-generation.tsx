"use client";

import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  Download,
  ExternalLink,
  FileJson,
  Loader2,
  MessageCircleQuestion,
  Quote,
  Star,
  Wallet,
  X,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import {
  chipClass,
  ghostButtonClass,
  monoLabelClass,
  paperCardClass,
} from "@/components/assistant-ui/elements";
import { usePollinationsStore } from "@/lib/pollinations/store";

/**
 * media_generation tool result renderers — one presentation per operation
 * family, honest at every step:
 *
 *  - running  → compact "Waiting for your confirmation…" (a dialog is on
 *               screen) / "Generating via Pollinations…" state.
 *  - ok:false → amber error card with the real reason, code, hint and
 *               retry-after; cancelled=true → the quiet "nothing was
 *               generated, no Pollen spent" card.
 *  - ok:true  → the deliverable: inline <img>/<video>/<audio>, GLB file
 *               card, text/transcript cards, balance tiles, usage table,
 *               live model lists, job rows, JSON payload disclosures.
 */

// ---------------------------------------------------------------------------
// Types + parsing.
// ---------------------------------------------------------------------------

interface CostInfo {
  free?: boolean;
  estimated_pollen?: number | null;
  estimate_basis?: string;
  actual_pollen?: number | null;
  note?: string;
}

interface JobInfo {
  id?: string;
  operation?: string;
  kind?: string;
  model?: string;
  prompt?: string;
  status?: string;
  createdAt?: string;
  endedAt?: string;
  timeMs?: number;
  url?: string | null;
  error?: string;
  estimatedPollen?: number | null;
  actualPollen?: number | null;
}

type Rec = Record<string, unknown>;

/** Parse the tool result (object or JSON string; unwraps legacy
 *  `{success, output}` shells the way ask-user/chart renderers did). */
function parseMediaResult(toolCall: ToolCall): Rec | null {
  const r = toolCall.result;
  let obj: unknown = null;
  if (typeof r === "string") {
    try {
      obj = JSON.parse(r);
    } catch {
      return null;
    }
  } else if (r && typeof r === "object" && !Array.isArray(r)) {
    obj = r;
  } else {
    return null;
  }
  const rec = obj as Rec;
  // Unwrap { success, output: {…media payload…} } shells.
  const out = rec.output;
  if (
    rec.operation === undefined &&
    out && typeof out === "object" && !Array.isArray(out) &&
    ("operation" in (out as Rec) || "ok" in (out as Rec))
  ) {
    return out as Rec;
  }
  return rec;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function fmtPollen(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v === 0) return "0";
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
  return v.toPrecision(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || ms <= 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human labels for the generation `kind`. */
const KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  "3d": "3D Model",
  text: "Text",
  embeddings: "Embeddings",
  transcription: "Transcription",
  realtime: "Realtime Session",
};

function kindLabel(kind: string | undefined): string {
  if (!kind) return "Pollinations";
  return KIND_LABELS[kind] ?? kind;
}

/** Friendly card label per operation (used by tool-call-card + this file). */
const OPERATION_LABELS: Record<string, string> = {
  list_models: "Pollinations Models",
  list_models_with_modalities: "Model Capabilities",
  get_model_details: "Model Details",
  select_model: "Select Model",
  set_default_model: "Set Default Model",
  get_default_models: "Default Models",
  check_pollen_balance: "Pollen Balance",
  get_usage_information: "Pollen Usage",
  connection_status: "Pollinations Connection",
  generate_text: "Generate Text",
  generate_image: "Generate Image",
  generate_video: "Generate Video",
  generate_audio: "Generate Audio",
  generate_3d: "Generate 3D Model",
  transcribe_audio: "Transcribe Audio",
  generate_embeddings: "Generate Embeddings",
  run_realtime_session: "Realtime Session",
  get_generation_status: "Generation Status",
  wait_for_generation: "Wait for Generation",
  cancel_generation: "Cancel Generation",
  list_generation_history: "Generation History",
  publish_model: "Publish Model",
  list_my_models: "My Pollinations Models",
  update_my_model: "Update My Model",
  delete_my_model: "Delete My Model",
  test_my_model: "Test My Model",
  publish_agent: "Publish Agent",
  list_agents: "My Agents",
  update_agent: "Update Agent",
  delete_agent: "Delete Agent",
  sync_code_agent: "Sync Code Agent",
};

export function mediaOperationLabel(operation: string | undefined): string {
  if (!operation) return "Pollinations";
  return OPERATION_LABELS[operation] ?? "Pollinations";
}

/** The kind implied by an operation (for the running state label). */
const OPERATION_KIND: Record<string, string> = {
  generate_image: "image",
  generate_video: "video",
  generate_audio: "audio",
  generate_3d: "3d",
  generate_text: "text",
  transcribe_audio: "transcription",
  generate_embeddings: "embeddings",
  run_realtime_session: "realtime",
};

// ---------------------------------------------------------------------------
// Shared presentation atoms.
// ---------------------------------------------------------------------------

function FreeBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[9px] font-bold tracking-wide text-emerald-600 dark:text-emerald-400",
        className,
      )}
    >
      FREE
    </span>
  );
}

function HealthDot({ status }: { status: string | null | undefined }) {
  const s = status?.toLowerCase();
  const cls =
    s === "healthy"
      ? "bg-emerald-500"
      : s && s !== "unknown"
        ? "bg-amber-500"
        : "bg-muted-foreground/40";
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", cls)}
      title={`health: ${s ?? "unknown"}`}
      aria-label={`health ${s ?? "unknown"}`}
    />
  );
}

/** Cost chip — FREE badge for free models, "≈ N pollen" for estimates,
 *  honest "settled later" otherwise. */
function CostChip({ cost }: { cost: CostInfo | undefined }) {
  if (!cost) return null;
  if (cost.free) return <FreeBadge />;
  const est = fmtPollen(cost.estimated_pollen ?? null);
  if (est !== null) return <span className={chipClass}>≈ {est} pollen</span>;
  return (
    <span className={chipClass} title={cost.estimate_basis ?? undefined}>
      cost settled later
    </span>
  );
}

function MediaChips({
  model,
  modelTitle,
  cost,
  timeMs,
  count,
  extra,
}: {
  model?: string;
  modelTitle?: string;
  cost?: CostInfo;
  timeMs?: number;
  count?: number;
  extra?: string;
}) {
  const chips: ReactNode[] = [];
  if (modelTitle || model) {
    chips.push(
      <span key="model" className={chipClass} title={model}>
        {modelTitle ?? model}
      </span>,
    );
  }
  if (count && count > 1) {
    chips.push(
      <span key="count" className={chipClass}>
        {count} outputs
      </span>,
    );
  }
  if (extra) chips.push(<span key="extra" className={chipClass}>{extra}</span>);
  const costChip = <CostChip key="cost" cost={cost} />;
  const time = fmtDuration(timeMs);
  if (chips.length === 0 && !cost && !time) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips}
      {cost ? costChip : null}
      {time ? (
        <span key="time" className={chipClass}>
          {time}
        </span>
      ) : null}
    </div>
  );
}

/** Download + open-in-new-tab icon buttons (the old image-generation
 *  pattern — ghostButtonClass anchors). */
function MediaActions({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <a
        href={url}
        download
        target="_blank"
        rel="noreferrer"
        aria-label={`Download ${label}`}
        title={`Download ${label}`}
        className={ghostButtonClass}
      >
        <Download className="h-3.5 w-3.5" />
      </a>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${label} in a new tab`}
        title={`Open ${label} in a new tab`}
        className={ghostButtonClass}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function PromptCaption({ prompt }: { prompt: string | undefined }) {
  if (!prompt) return null;
  return (
    <p className="text-muted-foreground truncate font-mono text-xs" title={prompt}>
      {prompt}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Generation deliverables.
// ---------------------------------------------------------------------------

function urlsOf(data: Rec): string[] {
  const list = Array.isArray(data.urls) ? data.urls : [];
  const out = list.map((u) => String(u ?? "")).filter(Boolean);
  const primary = str(data.url);
  if (primary && !out.includes(primary)) out.unshift(primary);
  return out;
}

function ImageResult({ data }: { data: Rec }) {
  const urls = urlsOf(data);
  const prompt = str(data.prompt);
  const count = num(data.count) ?? urls.length;
  const cost = data.cost as CostInfo | undefined;
  if (urls.length === 0) return <QuietNote text="No image data was returned." />;
  return (
    <figure className="step-card-in w-full max-w-sm space-y-2 py-1" data-slot="media-generation-image">
      {urls.length > 1 ? (
        <div className="grid grid-cols-2 gap-1.5">
          {urls.map((u, i) => (
            <a
              key={u.slice(0, 64) + i}
              href={u}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-lg border border-border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- provider/stored media URLs, not static assets */}
              <img
                src={u}
                alt={prompt ? `${prompt} (variation ${i + 1})` : `Generated image ${i + 1}`}
                className="h-auto w-full select-none"
                loading="lazy"
                draggable={false}
              />
            </a>
          ))}
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- provider/stored media URL, not a static asset
        <img
          src={urls[0]!}
          alt={prompt ?? "Generated image"}
          className="h-auto w-full max-w-sm rounded-xl border border-border select-none"
          loading="lazy"
          draggable={false}
        />
      )}
      <figcaption className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <PromptCaption prompt={prompt} />
          <MediaChips
            model={str(data.model)}
            modelTitle={str(data.model_title)}
            cost={cost}
            timeMs={num(data.time_ms)}
            count={count}
          />
        </div>
        <MediaActions url={urls[0]!} label="image" />
      </figcaption>
    </figure>
  );
}

function VideoResult({ data }: { data: Rec }) {
  const urls = urlsOf(data);
  const prompt = str(data.prompt);
  const cost = data.cost as CostInfo | undefined;
  return (
    <div className="step-card-in w-full max-w-sm space-y-2 py-1">
      {urls.map((u, i) => (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- provider-generated video streams ship no caption tracks; the prompt is exposed as the aria-label
        <video
          key={u.slice(0, 64) + i}
          src={u}
          controls
          playsInline
          preload="metadata"
          className="w-full max-w-sm rounded-xl border border-border bg-black"
          aria-label={prompt ? `Generated video: ${prompt}` : "Generated video"}
        />
      ))}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <PromptCaption prompt={prompt} />
          <MediaChips
            model={str(data.model)}
            modelTitle={str(data.model_title)}
            cost={cost}
            timeMs={num(data.time_ms)}
            count={num(data.count) ?? (urls.length > 1 ? urls.length : undefined)}
          />
        </div>
        {urls[0] ? <MediaActions url={urls[0]} label="video" /> : null}
      </div>
    </div>
  );
}

function AudioResult({ data }: { data: Rec }) {
  const urls = urlsOf(data);
  const prompt = str(data.prompt);
  const cost = data.cost as CostInfo | undefined;
  return (
    <div className="step-card-in w-full max-w-sm space-y-2 py-1">
      {urls.map((u, i) => (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- provider-generated audio ships no caption tracks
        <audio key={u.slice(0, 64) + i} src={u} controls preload="metadata" className="w-full max-w-sm" />
      ))}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <PromptCaption prompt={prompt} />
          <MediaChips
            model={str(data.model)}
            modelTitle={str(data.model_title)}
            cost={cost}
            timeMs={num(data.time_ms)}
            count={num(data.count) ?? (urls.length > 1 ? urls.length : undefined)}
          />
        </div>
        {urls[0] ? <MediaActions url={urls[0]} label="audio" /> : null}
      </div>
    </div>
  );
}

function ThreeDResult({ data }: { data: Rec }) {
  const url = str(data.url);
  const cost = data.cost as CostInfo | undefined;
  const prompt = str(data.prompt);
  return (
    <div className="step-card-in w-full max-w-sm space-y-2 py-1">
      <div className={cn(paperCardClass, "flex items-center gap-3 p-3")}>
        <span className="bg-primary/10 text-primary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Box className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">3D model · GLB</p>
          <p className="text-muted-foreground truncate text-xs" title={str(data.model)}>
            {str(data.model_title) ?? str(data.model) ?? "Pollinations 3D"}
          </p>
        </div>
        {url ? <MediaActions url={url} label="3D model" /> : null}
      </div>
      <PromptCaption prompt={prompt} />
      <MediaChips model={str(data.model)} cost={cost} timeMs={num(data.time_ms)} />
    </div>
  );
}

function TextResult({ data }: { data: Rec }) {
  const text = str(data.text);
  const cost = data.cost as CostInfo | undefined;
  if (!text) return <QuietNote text="The model returned an empty response." />;
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-xl border border-border bg-background/70 px-3.5 py-3 text-sm leading-relaxed break-words text-foreground/90 whitespace-pre-wrap">
        {text}
      </div>
      <MediaChips
        model={str(data.model)}
        modelTitle={str(data.model_title)}
        cost={cost}
        timeMs={num(data.time_ms)}
      />
    </div>
  );
}

function TranscriptCard({
  data,
  field,
  label,
}: {
  data: Rec;
  field: "transcript";
  label: string;
}) {
  const transcript = str(data[field]);
  const cost = data.cost as CostInfo | undefined;
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      {transcript ? (
        <blockquote className="border-primary/40 text-foreground/85 max-h-96 overflow-y-auto rounded-r-lg border-l-2 py-1 pl-3 text-sm leading-relaxed break-words whitespace-pre-wrap scrollbar-thin">
          <Quote className="text-primary/40 mb-1 h-3 w-3 shrink-0" aria-hidden />
          {transcript}
        </blockquote>
      ) : (
        <QuietNote text={`The ${label.toLowerCase()} returned no text.`} />
      )}
      <MediaChips
        model={str(data.model)}
        modelTitle={str(data.model_title)}
        cost={cost}
        timeMs={num(data.time_ms)}
      />
    </div>
  );
}

function EmbeddingsResult({ data }: { data: Rec }) {
  const count = num(data.count) ?? 0;
  const dims = num(data.dimensions);
  const cost = data.cost as CostInfo | undefined;
  const preview = Array.isArray(data.preview) ? data.preview.map((v) => Number(v)) : [];
  const floats = preview.filter((v) => Number.isFinite(v));
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={chipClass}>
          {count} vector{count === 1 ? "" : "s"} × {dims ?? "?"} dims
        </span>
        <span className={chipClass} title={str(data.model)}>
          {str(data.model_title) ?? str(data.model) ?? "embeddings model"}
        </span>
        <CostChip cost={cost} />
      </div>
      {floats.length > 0 ? (
        <p className="text-muted-foreground/80 truncate font-mono text-[10px]">
          [{floats.map((f) => f.toFixed(4)).join(", ")}, …]
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account / catalog cards.
// ---------------------------------------------------------------------------

function BalanceResult({ data }: { data: Rec }) {
  const balance = num(data.balance);
  const account = data.account_balance as { total?: number; tier?: number; paid?: number } | undefined;
  const tiers = data.pollen_tiers as Rec | undefined;
  const note = str(data.note) ?? str(tiers?.note);
  return (
    <div className={cn(paperCardClass, "step-card-in w-full max-w-sm space-y-3 p-3.5")}>
      <div>
        <p className={monoLabelClass}>Pollen balance</p>
        <p className="text-foreground mt-1 text-2xl font-bold tabular-nums">
          {balance !== undefined ? balance.toLocaleString() : "—"}
          <span className="text-muted-foreground ml-1.5 text-sm font-medium">Pollen</span>
        </p>
      </div>
      {account ? (
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { label: "Total", value: account.total },
              { label: "Quest Pollen", value: account.tier },
              { label: "Paid Pollen", value: account.paid },
            ] as const
          ).map((tile) => (
            <div key={tile.label} className="rounded-lg border border-border bg-background/70 p-2">
              <p className="text-muted-foreground truncate text-[9px] font-medium tracking-wide uppercase">
                {tile.label}
              </p>
              <p className="text-foreground mt-0.5 text-sm font-semibold tabular-nums">
                {typeof tile.value === "number" ? tile.value.toLocaleString() : "—"}
              </p>
            </div>
          ))}
        </div>
      ) : note ? (
        <p className="text-muted-foreground text-xs leading-relaxed">{note}</p>
      ) : null}
      <p className="text-muted-foreground/70 text-[10px]">
        checked {fmtTime(str(data.checked_at))} · live from the provider
      </p>
    </div>
  );
}

function UsageResult({ data }: { data: Rec }) {
  const rows = (Array.isArray(data.provider_usage) ? data.provider_usage : []) as Rec[];
  const total = num(data.provider_total_cost_pollen);
  const days = num(data.window_days);
  const recent = rows.slice(0, 8);
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      <p className={monoLabelClass}>Usage — actual provider costs</p>
      <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-muted/80 sticky top-0 backdrop-blur">
            <tr className="text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">Time</th>
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">Model</th>
              <th className="px-2 py-1.5 text-right font-medium">Cost</th>
              <th className="px-2 py-1.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground px-2 py-3 text-center italic">
                  No provider usage rows in this window.
                </td>
              </tr>
            ) : (
              recent.map((r, i) => {
                const cost = num(r.cost_pollen);
                return (
                  <tr key={String(r.cursor_event_id ?? r.timestamp ?? i)} className="align-top">
                    <td className="text-muted-foreground px-2 py-1.5 whitespace-nowrap">
                      {fmtTime(str(r.timestamp))}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{str(r.type) ?? "—"}</td>
                    <td className="max-w-40 px-2 py-1.5">
                      <span className="block truncate" title={str(r.model)}>
                        {str(r.model) ?? "—"}
                      </span>
                    </td>
                    <td className="text-foreground px-2 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                      {cost !== undefined ? `${fmtPollen(cost) ?? "0"} p` : "—"}
                    </td>
                    <td className="text-muted-foreground px-2 py-1.5 whitespace-nowrap">
                      {str(r.meter_source) ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {total !== undefined ? (
          <span className={chipClass}>Σ {fmtPollen(total) ?? "0"} pollen</span>
        ) : null}
        {days !== undefined ? <span className={chipClass}>last {days} days</span> : null}
        {rows.length > recent.length ? (
          <span className={chipClass}>{rows.length} total rows</span>
        ) : null}
      </div>
    </div>
  );
}

interface ModelRow {
  id: string;
  title: string;
  publisher: string;
  category: string;
  community: boolean;
  free: boolean;
  recommended: boolean;
  price: string;
  health?: string;
}

/** Normalize BOTH result shapes: modelSummary rows (list_models) and full
 *  ModelCapabilityInfo records (list_models_with_modalities). */
function toModelRow(r: Rec): ModelRow {
  const pollen = r.pollen as Rec | undefined;
  const availability = r.availability as Rec | undefined;
  const free = r.free === true || pollen?.free === true;
  const health =
    (typeof r.health === "string" ? r.health : undefined) ??
    (typeof availability?.status === "string" ? (availability.status as string) : undefined);
  const priceLine = Array.isArray(pollen?.priceLines) ? (pollen?.priceLines as unknown[]) : [];
  return {
    id: String(r.id ?? r.name ?? "unknown"),
    title: String(r.title ?? r.display_name ?? r.id ?? "unknown"),
    publisher: String(r.publisher ?? "unknown"),
    category: String(r.category ?? "unknown"),
    community: r.community === true,
    free,
    recommended:
      r.recommended === true || (free && health?.toLowerCase() === "healthy" && r.community !== true),
    price:
      typeof r.price === "string"
        ? r.price
        : typeof priceLine[0] === "string"
          ? (priceLine[0] as string)
          : "pricing unknown",
    health,
  };
}

function ModelsListResult({ data }: { data: Rec }) {
  const rows = ((Array.isArray(data.models) ? data.models : []) as Rec[]).map(toModelRow);
  const showing = num(data.showing) ?? rows.length;
  const matched = num(data.matched) ?? num(data.total_in_catalogue) ?? rows.length;
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto pr-0.5">
        {rows.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-[13px] font-medium" title={m.id}>
                {m.title}
                <span className="text-muted-foreground font-normal"> · {m.publisher}</span>
              </p>
              <p className="text-muted-foreground truncate font-mono text-[10px]">{m.price}</p>
            </div>
            {m.recommended ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-bold tracking-wide text-amber-600 dark:text-amber-400"
                title="Free, healthy and official — recommended"
              >
                <Star className="h-3 w-3 fill-current" aria-hidden />
                Recommended
              </span>
            ) : null}
            {m.free ? <FreeBadge /> : null}
            <span className={chipClass}>{m.category}</span>
            <HealthDot status={m.health} />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-[10px]">
        Showing {showing} of {matched} — fetched live
      </p>
    </div>
  );
}

function DefaultsResult({ data }: { data: Rec }) {
  const defaults = (data.defaults && typeof data.defaults === "object" ? data.defaults : {}) as Rec;
  const entries = Object.entries(defaults).filter(([, v]) => v && typeof v === "object");
  const note = str(data.note);
  return (
    <div className="step-card-in w-full max-w-md space-y-1.5 py-1">
      {entries.length === 0 ? (
        <QuietNote text={note ?? "No Pollinations defaults saved yet."} />
      ) : (
        <ul className="space-y-1">
          {entries.map(([modality, v]) => {
            const d = v as Rec;
            const valid = d.valid === true;
            const warning = str(d.warning);
            return (
              <li
                key={modality}
                className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5"
              >
                <span className={chipClass}>{modality}</span>
                <span className="text-foreground/90 min-w-0 flex-1 truncate font-mono text-xs" title={str(d.model)}>
                  {str(d.model) ?? "—"}
                </span>
                {valid ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" aria-hidden />
                    valid
                  </span>
                ) : (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                    title={warning ?? "check this default"}
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    {warning ? "warning" : "check"}
                  </span>
                )}
                {d.free === true ? <FreeBadge /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ConnectionResult({ data }: { data: Rec }) {
  const status = str(data.status) ?? "unknown";
  const connected = data.connected === true || status === "connected";
  const expired = data.expired === true || status === "expired";
  const balance = data.balance as { balance?: number } | null | undefined;
  const profile = data.profile as { githubUsername?: string } | null | undefined;
  const hint = str(data.hint);
  const dot = connected
    ? "bg-emerald-500"
    : expired
      ? "bg-amber-500"
      : status === "checking"
        ? "bg-muted-foreground/60 animate-pulse"
        : "bg-muted-foreground/40";
  return (
    <div className={cn(paperCardClass, "step-card-in w-full max-w-sm space-y-2 p-3.5")}>
      <p className="flex items-center gap-2">
        <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", dot)} aria-hidden />
        <span className="text-foreground text-sm font-semibold capitalize">{status}</span>
        {str(data.method) ? <span className={chipClass}>{str(data.method)}</span> : null}
      </p>
      {str(data.expires_at) ? (
        <p className="text-muted-foreground font-mono text-[10px]">
          expires {fmtTime(str(data.expires_at))}
          {expired ? " (expired)" : ""}
        </p>
      ) : null}
      {str(data.scope) ? (
        <p className="text-muted-foreground truncate font-mono text-[10px]" title={str(data.scope)}>
          scope: {str(data.scope)}
        </p>
      ) : null}
      {profile?.githubUsername ? (
        <p className="text-muted-foreground font-mono text-[10px]">user: {profile.githubUsername}</p>
      ) : null}
      {balance && typeof balance.balance === "number" ? (
        <p className="text-foreground/85 text-xs">
          <Wallet className="mr-1 inline h-3 w-3" aria-hidden />
          {balance.balance.toLocaleString()} Pollen
        </p>
      ) : null}
      {hint ? (
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jobs + raw payload cards.
// ---------------------------------------------------------------------------

function JobStatusBadge({ status }: { status: string | undefined }) {
  const s = (status ?? "unknown").toLowerCase();
  if (s === "completed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
        <Check className="h-2.5 w-2.5" aria-hidden />
        completed
      </span>
    );
  }
  if (s === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-px text-[9px] font-bold text-destructive">
        <X className="h-2.5 w-2.5" aria-hidden />
        failed
      </span>
    );
  }
  if (s === "cancelled") {
    return (
      <span className="text-muted-foreground inline-flex shrink-0 items-center rounded border border-border bg-muted px-1.5 py-px text-[9px] font-bold">
        cancelled
      </span>
    );
  }
  if (s === "running" || s === "pending") {
    return (
      <span className="text-primary inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-px text-[9px] font-bold">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
        {s}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center rounded border border-border px-1.5 py-px text-[9px] font-bold">
      {s}
    </span>
  );
}

function JobRow({ job }: { job: JobInfo }) {
  const est = job.estimatedPollen;
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-1.5">
      <JobStatusBadge status={job.status} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 truncate text-[13px]">
          {mediaOperationLabel(job.operation)}
          <span className="text-muted-foreground"> · {job.model ?? "unknown model"}</span>
        </p>
        {job.prompt ? (
          <p className="text-muted-foreground/80 truncate font-mono text-[10px]" title={job.prompt}>
            {job.prompt}
          </p>
        ) : null}
      </div>
      {job.url ? (
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the generated media"
          title="Open the generated media"
          className={ghostButtonClass}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
      {typeof est === "number" && est > 0 ? (
        <span className={chipClass}>≈ {fmtPollen(est) ?? est} p</span>
      ) : null}
      {job.error ? (
        <p className="text-destructive/80 max-w-40 truncate text-[10px]" title={job.error}>
          {job.error}
        </p>
      ) : null}
    </li>
  );
}

function JobsResult({ data }: { data: Rec }) {
  const single = (data.job && typeof data.job === "object" ? (data.job as Rec) : null) as JobInfo | null;
  const list = (Array.isArray(data.jobs) ? data.jobs : []) as JobInfo[];
  const note = str(data.note) ?? str(data.progress_note);
  const rows = single ? [single] : list;
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      {rows.length === 0 ? (
        <QuietNote text="No generation jobs recorded in this browser session." />
      ) : (
        <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto pr-0.5">
          {rows.map((j, i) => (
            <JobRow key={j.id ?? i} job={j} />
          ))}
        </ul>
      )}
      {note ? <p className="text-muted-foreground text-[11px] leading-relaxed">{note}</p> : null}
    </div>
  );
}

function PayloadResult({ data, operation }: { data: Rec; operation: string }) {
  let json = "";
  try {
    json = JSON.stringify(data.result ?? data, null, 2);
  } catch {
    json = String(data.result ?? "(unserializable payload)");
  }
  if (json.length > 20_000) json = `${json.slice(0, 20_000)}\n… (truncated)`;
  return (
    <div className="step-card-in w-full max-w-xl space-y-1.5 py-1">
      <div className="flex items-center gap-2">
        <FileJson className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="text-foreground/85 text-xs font-medium">{mediaOperationLabel(operation)}</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
          <Check className="h-2.5 w-2.5" aria-hidden />
          ok
        </span>
      </div>
      <details className="rounded-lg border border-border bg-background/70">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-2.5 py-1.5 text-[11px] font-medium transition-colors">
          Raw provider payload
        </summary>
        <pre className="scrollbar-thin max-h-56 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap">
          {json}
        </pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal states (cancelled / failure / quiet notes).
// ---------------------------------------------------------------------------

function QuietNote({ text }: { text: string }) {
  return <p className="text-muted-foreground py-1 text-xs italic">{text}</p>;
}

function CancelledCard({ data }: { data: Rec }) {
  const reason = str(data.error);
  return (
    <div className="step-card-in flex w-full max-w-md items-start gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <X className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="text-muted-foreground min-w-0 text-xs leading-relaxed">
        Cancelled — nothing was generated, no Pollen spent.
        {reason ? <span className="text-muted-foreground/70"> {reason}</span> : null}
      </p>
    </div>
  );
}

function ErrorCard({ data, operation }: { data: Rec; operation: string }) {
  const rawErr = data.error;
  const message =
    typeof rawErr === "string"
      ? rawErr
      : typeof (rawErr as Rec | undefined)?.message === "string"
        ? (rawErr as Rec).message as string
        : "media generation failed";
  const code = num(data.code);
  const hint = str(data.hint);
  const retryAfter = num(data.retryAfter);
  return (
    <div className={cn(paperCardClass, "step-card-in w-full max-w-md space-y-2 p-3")}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <div className="min-w-0">
          <p className="text-foreground text-xs font-semibold">
            {mediaOperationLabel(operation)} — didn&apos;t work
          </p>
          <p className="text-muted-foreground mt-0.5 break-words font-mono text-[11px] leading-relaxed">
            {message}
            {code ? ` (code ${code})` : ""}
          </p>
        </div>
      </div>
      {hint ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-2">
          <p className="text-[10px] font-bold tracking-wide text-amber-600 uppercase dark:text-amber-400">
            What to do
          </p>
          <p className="text-foreground/80 mt-0.5 text-[11px] leading-relaxed break-words">{hint}</p>
        </div>
      ) : null}
      {retryAfter !== undefined ? (
        <span className={chipClass}>retry in ~{retryAfter}s</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------

export function MediaGenerationResult({ toolCall }: { toolCall: ToolCall }) {
  // While the tool runs, a pending confirmation payload means the dialog is
  // on screen RIGHT NOW — narrate the honest wait state.
  const pending = usePollinationsStore((s) => s.pendingConfirmation);
  const running = toolCall.status === "pending" || toolCall.status === "running";

  const data = useMemo(() => parseMediaResult(toolCall), [toolCall]);
  const argsOperation = toolCall.args && typeof toolCall.args.operation === "string"
    ? (toolCall.args.operation as string)
    : undefined;
  const operation = str(data?.operation) ?? argsOperation ?? "";

  if (running) {
    const kind = kindLabel(OPERATION_KIND[operation]);
    const waiting = !!pending;
    return (
      <div className="flex items-center gap-2 px-0.5 py-1 text-xs" role="status" aria-live="polite">
        {waiting ? (
          <MessageCircleQuestion className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <Loader2 className="text-primary h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        )}
        <span className="text-foreground/80 font-medium">
          {waiting ? "Waiting for your confirmation…" : "Generating via Pollinations…"}
        </span>
        <span className={chipClass}>{kind}</span>
      </div>
    );
  }

  if (!data) return null; // nothing parseable — the card line still narrates

  if (data.cancelled === true) return <CancelledCard data={data} />;
  if (data.ok !== true) return <ErrorCard data={data} operation={operation} />;

  switch (operation) {
    case "generate_image":
      return <ImageResult data={data} />;
    case "generate_video":
      return <VideoResult data={data} />;
    case "generate_audio":
      return <AudioResult data={data} />;
    case "generate_3d":
      return <ThreeDResult data={data} />;
    case "generate_text":
      return <TextResult data={data} />;
    case "transcribe_audio":
      return <TranscriptCard data={data} field="transcript" label="Transcription" />;
    case "run_realtime_session":
      return <TranscriptCard data={data} field="transcript" label="Realtime session" />;
    case "generate_embeddings":
      return <EmbeddingsResult data={data} />;
    case "check_pollen_balance":
      return <BalanceResult data={data} />;
    case "get_usage_information":
      return <UsageResult data={data} />;
    case "list_models":
    case "list_models_with_modalities":
      return <ModelsListResult data={data} />;
    case "get_default_models":
      return <DefaultsResult data={data} />;
    case "connection_status":
      return <ConnectionResult data={data} />;
    case "get_generation_status":
    case "wait_for_generation":
    case "cancel_generation":
    case "list_generation_history":
      return <JobsResult data={data} />;
    default:
      // publish_model / list_my_models / update_* / delete_* / sync_* /
      // test_my_model / select_model / set_default_model / anything new.
      return <PayloadResult data={data} operation={operation} />;
  }
}
