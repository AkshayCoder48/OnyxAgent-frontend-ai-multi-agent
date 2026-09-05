import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Brain,
  Clock,
  Download,
  FileMinus,
  FilePlus,
  FileSearch,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolCall } from "@/types";

/**
 * Friendly narration for tool activity — plain-language sentences that say
 * what the agent DID, with no tool names, no code, no raw arguments. The
 * "simple" display mode (`tool-display-store`) renders these instead of the
 * technical verb/chip trace from `agent-tool-steps.ts`.
 *
 * Rules of thumb (the "non-coding-ish" contract):
 *  - the user's own search words are natural language → safe to quote;
 *  - a URL collapses to its domain ("on wikipedia.org");
 *  - a file path collapses to its bare name (a name, not code);
 *  - commands, code, and JSON arguments are NEVER shown.
 *
 * Dependency-free (types + icons only) — safe to import anywhere.
 */

export interface FriendlyStep {
  /** Past-tense sentence for a settled step — "Searched the web". */
  past: string;
  /** Present-tense caption for a running step — "Searching the web". */
  present: string;
  /** Plain-language target appended to the sentence — `for “weather”`,
   *  `on wikipedia.org`, `notes.md`. Undefined when there's nothing
   *  human-friendly to say. */
  detail?: string;
  icon: LucideIcon;
}

interface TenseRule {
  past: string;
  present: string;
  icon: LucideIcon;
}

const RULES: Record<string, TenseRule> = {
  // ── Search family ──────────────────────────────────────────────────────
  web_search: { past: "Searched the web", present: "Searching the web", icon: Search },
  web_search_tool: { past: "Searched the web", present: "Searching the web", icon: Search },
  search_web: { past: "Searched the web", present: "Searching the web", icon: Search },
  image_search: { past: "Searched for images", present: "Searching for images", icon: Search },
  video_search: { past: "Searched for videos", present: "Searching for videos", icon: Search },
  search_knowledge_base: {
    past: "Searched your documents",
    present: "Searching your documents",
    icon: Search,
  },
  search_documents: {
    past: "Searched your documents",
    present: "Searching your documents",
    icon: Search,
  },
  search_workspace: {
    past: "Searched the workspace",
    present: "Searching the workspace",
    icon: Search,
  },
  web_fetch: { past: "Read a web page", present: "Reading a web page", icon: Globe },
  fetch_url: { past: "Read a web page", present: "Reading a web page", icon: Globe },

  // ── Files & workspace ──────────────────────────────────────────────────
  read_file: { past: "Read a file", present: "Reading a file", icon: FileSearch },
  read_file_section: { past: "Read a file", present: "Reading a file", icon: FileSearch },
  verify_path: { past: "Checked a file", present: "Checking a file", icon: FileSearch },
  list_folder: {
    past: "Looked through the files",
    present: "Looking through the files",
    icon: FolderOpen,
  },
  list_files: {
    past: "Looked through the files",
    present: "Looking through the files",
    icon: FolderOpen,
  },
  list_workspace_files: {
    past: "Looked through the files",
    present: "Looking through the files",
    icon: FolderOpen,
  },
  edit_file: { past: "Updated a file", present: "Updating a file", icon: PenLine },
  create_file: { past: "Created a file", present: "Creating a file", icon: FilePlus },
  write_file: { past: "Created a file", present: "Creating a file", icon: FilePlus },
  create_file_chunk: { past: "Created a file", present: "Creating a file", icon: FilePlus },
  delete_file: { past: "Removed a file", present: "Removing a file", icon: FileMinus },
  create_folder: { past: "Created a folder", present: "Creating a folder", icon: FolderOpen },
  run_terminal: { past: "Ran a command", present: "Running a command", icon: Terminal },
  run_python: { past: "Ran a calculation", present: "Doing a calculation", icon: Terminal },

  // ── Charts, questions, plans ───────────────────────────────────────────
  create_chart: { past: "Made a chart", present: "Making a chart", icon: BarChart3 },
  create_chart_tool: { past: "Made a chart", present: "Making a chart", icon: BarChart3 },
  create_map_tool: { past: "Made a map", present: "Making a map", icon: Globe },
  ask_user: { past: "Asked you a question", present: "Asking you a question", icon: MessageCircleQuestion },
  manage_todo: { past: "Updated the plan", present: "Updating the plan", icon: ListTodo },
  manage_todos: { past: "Updated the plan", present: "Updating the plan", icon: ListTodo },
  show_todo: { past: "Checked the plan", present: "Checking the plan", icon: ListChecks },
  read_todos: { past: "Checked the plan", present: "Checking the plan", icon: ListChecks },

  // ── Memory & time (client-side tools — always available) ───────────────
  memory_save: {
    past: "Saved something to remember",
    present: "Saving it to memory",
    icon: Brain,
  },
  memory_list: { past: "Looked through memories", present: "Reading memories", icon: Brain },
  memory_search: { past: "Searched memories", present: "Searching memories", icon: Brain },
  get_current_datetime: {
    past: "Checked the date and time",
    present: "Checking the date and time",
    icon: Clock,
  },
  current_datetime: {
    past: "Checked the date and time",
    present: "Checking the date and time",
    icon: Clock,
  },

  // ── Skills & downloads ─────────────────────────────────────────────────
  load_skill: { past: "Loaded a skill", present: "Loading a skill", icon: Wrench },
  list_skills: {
    past: "Listed the available skills",
    present: "Listing the available skills",
    icon: Wrench,
  },
  send_file: { past: "Prepared a file for you", present: "Preparing a file for you", icon: Download },
  send_folder: {
    past: "Prepared a folder for you",
    present: "Preparing a folder for you",
    icon: Download,
  },
  preview_image: { past: "Showed an image", present: "Showing an image", icon: ImageIcon },

  // ── Merged multi-function tools (tool-count cap) ─────────────────────
  // Each maps to the old family it absorbed; sentences stay generic and
  // human. The per-action nuance rides the detail chip (args.action).
  manage_memory: {
    past: "Worked with its memories",
    present: "Working with memories",
    icon: Brain,
  },
  manage_env_var: {
    past: "Managed environment variables",
    present: "Managing environment variables",
    icon: Wrench,
  },
  manage_skill: { past: "Managed skills", present: "Managing skills", icon: Wrench },
  manage_mcp: { past: "Managed MCP servers", present: "Managing MCP servers", icon: Globe },
  manage_custom_tool: { past: "Built a custom tool", present: "Building a custom tool", icon: Wrench },
  manage_subagent_chat: {
    past: "Managed a subagent chat",
    present: "Managing a subagent chat",
    icon: MessageCircleQuestion,
  },
  manage_chats: { past: "Looked up past chats", present: "Looking up past chats", icon: FileSearch },
  ocr_document: { past: "Read a document", present: "Reading a document", icon: ImageIcon },
};

function humanize(name: string): string {
  const words = name.replace(/_tool$/, "").split("_").filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Truncate a detail string so sentences never blow the layout. */
function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Domain of a URL ("https://en.wikipedia.org/wiki/X" → "en.wikipedia.org"),
 *  with a bare "www." stripped. null when it isn't a readable web address. */
function domainOf(url: string): string | null {
  try {
    if (url.startsWith("data:")) return null;
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** A path's bare name — "src/app/page.tsx" → "page.tsx" (a name, not code). */
function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.trim() ? name : path;
}

/**
 * The friendly detail appended to a step's sentence, when the primary
 * argument is human-readable. Deliberately omits commands, code, and every
 * other code-ish argument — the simple view never shows those.
 */
function friendlyDetail(toolCall: ToolCall): string | undefined {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  // The user's own search words are natural language — safe to quote.
  if (typeof args.query === "string" && args.query.trim()) {
    return `for “${clip(args.query.trim())}”`;
  }
  if (typeof args.url === "string" && args.url.trim()) {
    const domain = domainOf(args.url.trim());
    if (domain) return `on ${domain}`;
  }
  const path =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    null;
  if (path && path.trim()) return basename(path.trim());
  return undefined;
}

/** One tool call → one friendly step (past + present sentence, detail, icon). */
export function friendlyStep(toolCall: ToolCall): FriendlyStep {
  const name = toolCall.name ?? "";
  const rule = RULES[name] ?? {
    past: `Used ${humanize(name)}`,
    present: `Using ${humanize(name)}`,
    icon: Wrench,
  };
  return { past: rule.past, present: rule.present, detail: friendlyDetail(toolCall), icon: rule.icon };
}

/** The settled card header sentence — "Searched the web for “weather”". */
export function friendlySentence(toolCall: ToolCall): string {
  const step = friendlyStep(toolCall);
  return step.detail ? `${step.past} ${step.detail}` : step.past;
}
