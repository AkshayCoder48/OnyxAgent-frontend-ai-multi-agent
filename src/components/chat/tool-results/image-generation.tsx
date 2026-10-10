"use client";

import * as React from "react";
import { AlertTriangle, Download, ExternalLink, RefreshCw } from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import {
  ImageGeneration,
  chipClass,
  ghostButtonClass,
  monoLabelClass,
  paperCardClass,
} from "@/components/assistant-ui/elements";
import { generatePerchanceImage, type PerchanceResolution } from "@/lib/perchance/official-api";

/**
 * generate_image tool block — NOT a collapsible tool-call card.
 *
 * While the tool runs: the assistant-ui ImageGeneration element (pulsing dot
 * grid over a blurred gradient + shimmering "Generating" label). Once the
 * call resolves: the real image with its prompt as the caption and a
 * Regenerate button beside it (regeneration re-rolls the seed CLIENT-SIDE —
 * no new model turn needed). Failures render an honest error card with the
 * real perchance reason and a retry button.
 */

// ---------------------------------------------------------------------------
// Arg / result parsing.
// ---------------------------------------------------------------------------

interface GenArgs {
  prompt: string;
  negativePrompt: string;
  resolution: PerchanceResolution;
  seed: number;
  guidanceScale?: number;
}

function parseArgs(toolCall: ToolCall): GenArgs {
  const a = toolCall.args ?? {};
  const str = (k: string): string => {
    const v = a[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const num = (k: string): number | undefined => {
    const v = a[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const res = str("resolution");
  const resolution: PerchanceResolution =
    res === "512x768" || res === "768x512" || res === "768x768" ? res : "512x512";
  return {
    prompt: str("prompt"),
    negativePrompt: str("negative_prompt") || str("negativePrompt"),
    resolution,
    seed: num("seed") ?? -1,
    guidanceScale: num("guidance_scale") ?? num("guidanceScale"),
  };
}

interface GenResult {
  ok: boolean;
  url?: string;
  prompt?: string;
  seed?: number;
  resolution?: string;
  error?: string;
  code?: number;
  retryAfter?: number;
  timeMs?: number;
}

function parseResult(toolCall: ToolCall): GenResult | null {
  const r = toolCall.result;
  if (r == null) return null;
  if (typeof r === "object") return r as GenResult;
  if (typeof r === "string") {
    try {
      return JSON.parse(r) as GenResult;
    } catch {
      return null;
    }
  }
  return null;
}

/** resolution → frame label + aspect class. */
function frameStyle(resolution: string): { label: string; aspect: string } {
  switch (resolution) {
    case "512x768":
      return { label: "512 × 768", aspect: "aspect-[2/3]" };
    case "768x512":
      return { label: "768 × 512", aspect: "aspect-[3/2]" };
    case "768x768":
      return { label: "768 × 768", aspect: "aspect-square" };
    default:
      return { label: "512 × 512", aspect: "aspect-square" };
  }
}

// ---------------------------------------------------------------------------
// The block.
// ---------------------------------------------------------------------------

export function ImageGenerationBlock({ toolCall }: { toolCall: ToolCall }) {
  // Cheap pure parsing — the React Compiler memoizes these automatically.
  const args = parseArgs(toolCall);
  const result = parseResult(toolCall);

  const running = toolCall.status === "running" || toolCall.status === "pending";

  // Client-side regeneration state (re-rolled seed → new permanent URL).
  const [overrideUrl, setOverrideUrl] = React.useState<string | null>(null);
  const [regenState, setRegenState] = React.useState<
    { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const regenerate = React.useCallback(async () => {
    if (!args.prompt || regenState.kind === "running") return;
    setRegenState({ kind: "running" });
    try {
      const r = await generatePerchanceImage({
        prompt: args.prompt,
        negativePrompt: args.negativePrompt || undefined,
        resolution: args.resolution,
        guidanceScale: args.guidanceScale,
        seed: -1, // fresh roll — that's what "regenerate" means
      });
      if (r.ok) {
        setOverrideUrl(r.url);
        setRegenState({ kind: "idle" });
      } else {
        setRegenState({ kind: "error", message: r.error });
      }
    } catch (err) {
      setRegenState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [args.prompt, args.negativePrompt, args.resolution, args.guidanceScale, regenState.kind]);

  const frame = frameStyle(result?.resolution ?? args.resolution);

  // ── In flight (or a bridged call we cannot see) → the element frame. ────
  if (running) {
    return (
      <div className="step-card-in w-full max-w-sm py-1">
        <ImageGeneration
          prompt={args.prompt || "Waiting for the prompt…"}
          generating
          label={frame.label}
          frameClassName={frame.aspect}
        />
      </div>
    );
  }

  // ── Failure → honest error card + retry. ────────────────────────────────
  if (!result || result.ok === false) {
    const message = result?.error ?? "image generation failed";
    const code = result?.code;
    return (
      <div className={cn(paperCardClass, "w-full max-w-sm space-y-2 p-3")}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Image generation failed</p>
            <p className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
              {message}
              {code ? ` (code ${code})` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={regenState.kind === "running"}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium",
              "text-foreground transition-colors hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <RefreshCw
              className={cn("h-3 w-3", regenState.kind === "running" && "animate-spin")}
            />
            {regenState.kind === "running" ? "Retrying…" : "Retry"}
          </button>
          {typeof result?.retryAfter === "number" && (
            <span className={monoLabelClass}>retry in ~{result.retryAfter}s</span>
          )}
        </div>
      </div>
    );
  }

  // ── Success → the image with its caption + regenerate. ───────────────────
  const displayUrl = overrideUrl ?? result.url ?? "";
  const seed = overrideUrl ? undefined : result.seed;
  const promptCaption = result.prompt || args.prompt;

  return (
    <figure className="step-card-in w-full max-w-sm space-y-2 py-1" data-slot="image-generation-result">
      <div className="relative overflow-hidden rounded-xl border border-border bg-muted/40">
        {regenState.kind === "running" ? (
          <ImageGeneration
            prompt={promptCaption}
            generating
            label={frame.label}
            frameClassName={frame.aspect}
          />
        ) : displayUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayUrl}
            alt={promptCaption || "Generated image"}
            className="h-auto w-full select-none"
            loading="lazy"
            draggable={false}
          />
        ) : null}
      </div>
      <figcaption className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-foreground/80" title={promptCaption}>
            {promptCaption || "Generated image"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className={chipClass}>{frame.label}</span>
            {typeof seed === "number" && <span className={chipClass}>seed {seed}</span>}
            {typeof result.timeMs === "number" && result.timeMs > 0 && (
              <span className={chipClass}>{(result.timeMs / 1000).toFixed(1)}s</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {displayUrl && (
            <>
              <a
                href={displayUrl}
                download
                target="_blank"
                rel="noreferrer"
                aria-label="Download image"
                title="Download image"
                className={ghostButtonClass}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              <a
                href={displayUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open image in a new tab"
                title="Open image in a new tab"
                className={ghostButtonClass}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </>
          )}
          <button
            type="button"
            aria-label="Regenerate image"
            title="Regenerate image (new seed)"
            onClick={() => void regenerate()}
            disabled={regenState.kind === "running"}
            className={cn(ghostButtonClass, "h-7 w-7")}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", regenState.kind === "running" && "animate-spin")}
            />
          </button>
        </div>
      </figcaption>
      {regenState.kind === "error" && (
        <p className="break-words font-mono text-[11px] text-destructive">
          Regeneration failed: {regenState.message}
        </p>
      )}
    </figure>
  );
}
