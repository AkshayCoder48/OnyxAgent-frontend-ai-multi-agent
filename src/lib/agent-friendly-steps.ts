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
  Library,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  PenLine,
  Plug,
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
  inspect_image: { past: "Inspected an image", present: "Inspecting an image", icon: ImageIcon },
  generate_image: { past: "Generated an image", present: "Generating an image", icon: ImageIcon },

  // ── Merged multi-function tools (tool-count cap) ─────────────────────
  // Each maps to the old family it absorbed; sentences stay generic and
  // human. The per-action nuance rides the detail chip (args.action).
  manage_memory: {
    past: "Worked with its memories",
    present: "Working with memories",
    icon: Brain,
  },
  knowledge_base: {
    past: "Used the workspace Knowledge Base",
    present: "Using the Knowledge Base",
    icon: Library,
  },
  use_browser: {
    past: "Used the browser",
    present: "Using the browser",
    icon: Globe,
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

  // ── External apps (Composio) ──────────────────────────────────────────
  composio_search_tools: {
    past: "Searched app integrations",
    present: "Searching app integrations",
    icon: Plug,
  },
  composio_connect_platform: {
    past: "Prepared an app connection link",
    present: "Preparing an app connection link",
    icon: Plug,
  },
  composio_execute_tool: {
    past: "Used an app integration",
    present: "Using an app integration",
    icon: Plug,
  },
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
  // inspect_image's source: a path or URL (data URLs show as no detail —
  // a wall of base64 is never human-friendly).
  if (
    toolCall.name === "inspect_image" &&
    typeof args.source === "string" &&
    args.source.trim() &&
    !args.source.startsWith("data:")
  ) {
    const s = args.source.trim();
    const domain = domainOf(s);
    return domain ? `on ${domain}` : clip(basename(s));
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
  // knowledge_base — ONE tool, action-aware narration (the internal op is
  // the detail, never a separate tool in the UI): "Searching workspace
  // knowledge for “postgres”" / "Saved “DB Architecture” to the Knowledge
  // Base" / "Hosting a file in the Knowledge Base".
  if (name === "knowledge_base") {
    return kbStep(toolCall);
  }
  // use_browser — the ONE browser tool, action-aware narration ("Opened
  // example.com" / "Clicked “Sign in”" / "Took a screenshot").
  if (name === "use_browser") {
    return browserStep(toolCall);
  }
  const rule = RULES[name] ?? {
    past: `Used ${humanize(name)}`,
    present: `Using ${humanize(name)}`,
    icon: Wrench,
  };
  return { past: rule.past, present: rule.present, detail: friendlyDetail(toolCall), icon: rule.icon };
}

/** Action-aware narration for the unified knowledge_base tool. */
function kbStep(toolCall: ToolCall): FriendlyStep {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const title = typeof args.title === "string" && args.title.trim() ? clip(args.title.trim(), 48) : null;
  const fname = typeof args.name === "string" && args.name.trim() ? clip(args.name.trim(), 48) : null;
  const query = typeof args.query === "string" && args.query.trim() ? clip(args.query.trim(), 48) : null;

  switch (action) {
    case "search":
      return {
        past: query ? `Searched workspace knowledge for “${query}”` : "Searched workspace knowledge",
        present: query ? `Searching workspace knowledge for “${query}”` : "Searching workspace knowledge",
        icon: Library,
      };
    case "get":
      return { past: "Read a saved knowledge item", present: "Reading a saved knowledge item", icon: Library };
    case "save":
      return {
        past: title ? `Saved “${title}” to the Knowledge Base` : "Saved knowledge to the Knowledge Base",
        present: title ? `Saving “${title}” to the Knowledge Base` : "Saving knowledge to the Knowledge Base",
        icon: Library,
      };
    case "update":
      return {
        past: title ? `Updated “${title}” in the Knowledge Base` : "Updated knowledge in the Knowledge Base",
        present: "Updating knowledge in the Knowledge Base",
        icon: Library,
      };
    case "delete":
      return { past: "Deleted knowledge from the Knowledge Base", present: "Deleting knowledge from the Knowledge Base", icon: Library };
    case "list":
      return { past: "Listed the workspace knowledge", present: "Listing the workspace knowledge", icon: Library };
    case "save_file":
      return {
        past: fname ? `Hosted “${fname}” in the Knowledge Base` : "Hosted a file in the Knowledge Base",
        present: fname ? `Hosting “${fname}” in the Knowledge Base` : "Hosting a file in the Knowledge Base",
        icon: Library,
      };
    case "get_file":
      return { past: "Fetched a hosted file link", present: "Fetching a hosted file link", icon: Library };
    case "list_files":
      return { past: "Listed hosted files", present: "Listing hosted files", icon: Library };
    case "delete_file":
      return { past: "Deleted a hosted file", present: "Deleting a hosted file", icon: Library };
    default:
      return { past: "Used the workspace Knowledge Base", present: "Using the Knowledge Base", icon: Library };
  }
}

/** Action-aware narration for the unified browser tool (🌐 Browser). */
function browserStep(toolCall: ToolCall): FriendlyStep {
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const url = typeof args.url === "string" && args.url.trim() ? domainOf(args.url.trim()) ?? basename(args.url.trim()) : null;
  const targetText = (t: unknown): string | null => {
    if (typeof t === "string" && t.trim()) return clip(t.trim(), 40);
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const v = o.name ?? o.text ?? o.label ?? o.placeholder ?? o.alt ?? o.css ?? o.xpath ?? o.ref;
      if (typeof v === "string" && v.trim()) return clip(v.trim(), 40);
    }
    return null;
  };
  const target = targetText(args.target);
  const text = typeof args.text === "string" && args.text.trim() ? clip(args.text.trim(), 40) : null;

  switch (action) {
    case "navigate":
      return {
        past: url ? `Opened ${url}` : "Opened a website",
        present: url ? `Opening ${url}` : "Opening a website",
        icon: Globe,
      };
    case "click":
      return {
        past: target ? `Clicked “${target}”` : "Clicked a page element",
        present: target ? `Clicking “${target}”` : "Clicking a page element",
        icon: Globe,
      };
    case "type":
      return {
        past: target ? `Typed “${text ?? "…"}” into “${target}”` : `Typed “${text ?? "…"}”`,
        present: "Typing into the page",
        icon: Globe,
      };
    case "press":
      return { past: `Pressed ${typeof args.key === "string" ? args.key : "a key"}`, present: "Pressing a key", icon: Globe };
    case "scroll":
      return { past: "Scrolled the page", present: "Scrolling the page", icon: Globe };
    case "wait":
      return { past: "Waited for the page", present: "Waiting for the page", icon: Globe };
    case "screenshot":
      return { past: "Took a screenshot", present: "Taking a screenshot", icon: Globe };
    case "read":
      return { past: "Read the current page", present: "Reading the current page", icon: Globe };
    case "get_page":
      return { past: "Read the current page", present: "Reading the current page", icon: Globe };
    case "snapshot": {
      const op = typeof args.operation === "string" ? args.operation : "";
      return {
        past: "Captured a page snapshot",
        present: "Capturing a page snapshot",
        icon: Globe,
        detail: op || undefined,
      };
    }
    case "screen_record": {
      const op = typeof args.operation === "string" ? args.operation : "status";
      const label =
        op === "start" ? "Started a screen recording" : op === "stop" ? "Stopped the screen recording" : "Checked the recording status";
      return {
        past: label,
        present: op === "start" ? "Starting a screen recording" : op === "stop" ? "Stopping the screen recording" : "Checking the recording status",
        icon: Globe,
        detail: op,
      };
    }
    case "inspect":
      return { past: "Inspected the page elements", present: "Inspecting the page elements", icon: Globe };
    case "get_elements":
      return { past: "Inspected the page elements", present: "Inspecting the page elements", icon: Globe };
    case "evaluate":
      return { past: "Ran JavaScript in the page", present: "Running JavaScript in the page", icon: Globe };
    case "select":
      return { past: "Chose a dropdown option", present: "Choosing a dropdown option", icon: Globe };
    case "upload":
      return { past: "Uploaded files through the browser", present: "Uploading files through the browser", icon: Globe };
    case "download":
      return { past: "Downloaded a file", present: "Downloading a file", icon: Globe };
    case "new_tab":
      return { past: "Opened a new tab", present: "Opening a new tab", icon: Globe };
    case "switch_tab":
      return { past: "Switched browser tabs", present: "Switching browser tabs", icon: Globe };
    case "close_tab":
      return { past: "Closed a browser tab", present: "Closing a browser tab", icon: Globe };
    case "go_back":
      return { past: "Went back", present: "Going back", icon: Globe };
    case "back":
      return { past: "Went back", present: "Going back", icon: Globe };
    case "go_forward":
      return { past: "Went forward", present: "Going forward", icon: Globe };
    case "forward":
      return { past: "Went forward", present: "Going forward", icon: Globe };
    case "refresh":
      return { past: "Refreshed the page", present: "Refreshing the page", icon: Globe };
    case "reload":
      return { past: "Reloaded the page", present: "Reloading the page", icon: Globe };
    default:
      return { past: "Used the browser", present: "Using the browser", icon: Globe };
  }
}

/** The settled card header sentence — "Searched the web for “weather”". */
export function friendlySentence(toolCall: ToolCall): string {
  const step = friendlyStep(toolCall);
  return step.detail ? `${step.past} ${step.detail}` : step.past;
}
