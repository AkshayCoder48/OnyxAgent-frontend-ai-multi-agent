import type { ChatMessage } from "@/types";

/**
 * useStatusCaption — CAPTION GENERATION for the live status circle (user
 * directive: "re add it into that circle (caption) just like thinking").
 *
 * While a turn streams, the pulsing-dot circle's label is a GENERATED
 * caption describing what the agent is doing RIGHT NOW — derived
 * deterministically from the turn's own parts, so it is honest (it can
 * only narrate what actually happened) and instant (no API round-trip,
 * no hallucinated narration):
 *
 *   "Thinking"                    — a reasoning stream is open
 *   "Browsing perchance.org"      — use_browser running (URL host from args)
 *   "Searching the web"           — web/image/video search running
 *   "Reading example.com"         — web_fetch running
 *   "Running code"                — run_python / run_terminal
 *   "Writing"                     — the answer text is streaming at the tail
 *
 * The caption swaps with the same one-fade transition the "Thinking"
 * label uses (the ThinkingIndicator keys on its label) — static text,
 * no cycling animation.
 */

/** Pull a short host (sub-domain-stripped) from a URL-ish string. */
function hostOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/** Short, single-line clamp for query-ish captions. */
function clamp(text: unknown, max = 26): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** First present string among candidate arg keys. */
function firstArg(
  args: Record<string, unknown> | undefined,
  keys: string[],
): unknown {
  if (!args) return undefined;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Tool-specific captions — arg-aware where it reads naturally. */
function toolCaption(name: string, args: Record<string, unknown> | undefined): string {
  switch (name) {
    case "use_browser": {
      // Prefer the live URL the agent is driving at; non-navigate actions
      // (click/type/scroll) still say "Browsing the web".
      const host = hostOf(firstArg(args, ["url"]));
      return host ? `Browsing ${host}` : "Browsing the web";
    }
    case "web_search":
    case "image_search":
    case "video_search": {
      const q = clamp(firstArg(args, ["query", "q", "search", "keywords"]));
      return q ? `Searching “${q}”` : "Searching the web";
    }
    case "web_fetch":
    case "fetch_url": {
      const host = hostOf(firstArg(args, ["url"]));
      return host ? `Reading ${host}` : "Reading a page";
    }
    case "run_python":
    case "run_terminal":
      return "Running code";
    case "knowledge_base":
    case "search_documents":
      return "Checking the knowledge base";
    case "read_file":
    case "read_file_section":
    case "read_uploaded_file":
    case "list_folder":
    case "list_uploaded_files":
    case "analyze_workspace":
      return "Working with files";
    case "create_chart":
      return "Creating a chart";
    case "preview_image":
    case "image_gen":
    case "generate_image":
      return "Creating an image";
    case "spawn_subagent":
      return "Spawning a subagent";
    case "query_subagent":
    case "read_chat":
      return "Checking a subagent";
    case "ask_user":
      return "Waiting for your answer";
    case "manage_todo":
    case "show_todo":
      return "Updating the plan";
    case "manage_memory":
      return "Saving a memory";
    case "create_scheduled_task":
    case "update_scheduled_task":
      return "Scheduling a task";
    case "composio_execute_tool":
    case "mcp_call_tool":
      return "Running an integration";
    default: {
      // Honest generic: prettify the tool's own name ("send_file" →
      // "Using send file"). Every tool gets a caption, never a blank.
      const pretty = name.replace(/[_-]+/g, " ").trim();
      return pretty ? `Using ${pretty}` : "Working";
    }
  }
}

/**
 * Derive the CURRENT status caption for a streaming assistant message.
 * Settled messages (and non-assistant messages) return null — the caller
 * renders no live circle for them.
 */
export function statusCaptionFor(message: ChatMessage): string | null {
  if (message.role !== "assistant" || !message.isStreaming) return null;
  const parts = message.parts ?? [];

  // 1. A tool call executing / awaiting its result → the tool caption.
  //    (Scan from the END — the newest running call narrates.)
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p || p.type !== "tool" || !p.toolCall) continue;
    if (p.toolCall.status === "running" || p.toolCall.status === "pending") {
      return toolCaption(p.toolCall.name, p.toolCall.args);
    }
    break; // the LAST tool part is settled — no live tool
  }

  // 2. Reasoning stream open → Thinking (the circle stays; caption reads
  //    "Thinking" exactly like the pre-thinking state — continuity).
  const last = parts[parts.length - 1];
  if (
    parts.length > 0 &&
    (last?.type === "thinking" || last?.type === "reasoning") &&
    last.reasoningEndedAt === undefined
  ) {
    return "Thinking";
  }

  // 3. The tail is answer text → Writing.
  if (last?.type === "text" && last.content) return "Writing";

  // 4. Between rounds / opening round → Thinking.
  return "Thinking";
}
