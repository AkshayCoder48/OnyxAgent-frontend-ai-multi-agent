"use client";

// remember-page — the shared "remember this page" pipeline (KB deepening,
// 2026-11-05): capture a browsed page (title, URL, extracted text, the
// session's navigation history, an optional curated note) and save it as a
// Knowledge Base document.
//
// TWO callers share this module so the stored shape is IDENTICAL no matter
// who asked:
//   • the `use_browser` action `remember_page` (source "ai" — the agent
//     remembers a page it just browsed, optionally with its own note);
//   • the "Remember this page" button on browser read rows in the chat
//     (source "user" — the user saves the page the agent just read).
//
// The driver (browser-driver.ts do_remember_page) captures the page — this
// module only shapes + persists it. OnyxBase never receives the API key in
// content: only page data flows through.

import {
  kbSave,
  resolveKBClients,
  type KBItem,
  MAX_KB_CONTENT_CHARS,
} from "@/lib/onyxbase/kb-store";

/** One navigation-log entry as captured by the driver (do_navigate). */
export interface NavLogEntry {
  url: string;
  title?: string | null;
  /** Unix ms when the navigation settled. */
  ts?: number;
}

/** What a remember_page capture carries (driver payload + caller context). */
export interface RememberedPageInput {
  url: string;
  title: string;
  text: string;
  /** Curated note from the caller — WHY this page matters. */
  note?: string | null;
  /** The browser session's navigation log (browse-history ingestion). */
  navLog?: NavLogEntry[] | null;
  /** Include the nav log in the saved item (default true). */
  includeHistory?: boolean;
  /** Who triggered the save — badges the item in the KB tab. */
  source?: "ai" | "user";
  /** KB item type override (default "document"). */
  type?: "document" | "research" | "note" | "knowledge" | "memory" | "decision";
}

/** Result: either the saved item or an honest, actionable failure. */
export type RememberedPageResult =
  | { ok: true; item: KBItem; contentChars: number; historyIncluded: boolean }
  | { ok: false; code: "NOT_CONFIGURED" | "SAVE_FAILED" | "EMPTY_CAPTURE"; message: string };

/** Page-text budget for one remembered page. The KB cap is 400,000 chars —
 *  a single page gets 40,000 (same as the driver-side capture budget), the
 *  remainder is head-room for the note + history footer. */
export const REMEMBERED_PAGE_TEXT_BUDGET = 40_000;

/** Hostname of a URL ("https://a.b.org/x" → "a.b.org"), "" when unreadable. */
export function hostnameOf(url: string): string {
  try {
    if (url.startsWith("data:")) return "";
    return new URL(url).hostname.replace(/^www\./, "") || "";
  } catch {
    return "";
  }
}

/** Tags for a remembered page: fixed provenance tags + the hostname. */
export function rememberPageTags(url: string): string[] {
  const host = hostnameOf(url).toLowerCase().replace(/[^a-z0-9.-]/g, "");
  return ["browser", "saved-page", ...(host ? [host] : [])];
}

/** Local time label for a nav-log entry ("14:32"). */
function navTimeLabel(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * The saved item's content — a self-contained markdown document:
 * header (title/url/captured/note) + the page text + the session's
 * navigation log. Pure function (unit-pinned).
 */
export function buildRememberedPageContent(input: RememberedPageInput): string {
  const note = (input.note ?? "").trim();
  const text = (input.text ?? "").trim().slice(0, REMEMBERED_PAGE_TEXT_BUDGET);
  const lines: string[] = [];

  if (note) lines.push(`> **Note:** ${note.replace(/\n+/g, " ")}`);
  lines.push(`- **URL:** ${input.url || "(unknown)"}`);
  lines.push(`- **Captured:** ${new Date().toISOString()}`);
  if (text.length < (input.text ?? "").length) {
    lines.push(`- **Truncated:** page text capped at ${REMEMBERED_PAGE_TEXT_BUDGET.toLocaleString()} chars.`);
  }
  lines.push("");
  lines.push("## Page content");
  lines.push("");
  lines.push(text || "(no visible text)");

  const includeHistory = input.includeHistory !== false;
  const navLog = Array.isArray(input.navLog) ? input.navLog : [];
  if (includeHistory && navLog.length > 0) {
    lines.push("");
    lines.push("## Pages visited this session");
    lines.push("");
    navLog.slice(-30).forEach((entry, i) => {
      const t = navTimeLabel(entry.ts);
      const label = (entry.title ?? "").trim() || entry.url || "(untitled)";
      lines.push(`${i + 1}. [${label}](${entry.url || ""})${t ? ` — ${t}` : ""}`);
    });
  }
  return lines.join("\n");
}

/**
 * Capture → save pipeline. Resolves the OnyxBase clients (null when not
 * configured → the honest NOT_CONFIGURED answer), shapes the document and
 * saves it via kbSave. NEVER throws — failures resolve to { ok: false }.
 */
export async function rememberPageToKB(
  userId: string,
  input: RememberedPageInput,
): Promise<RememberedPageResult> {
  const title = (input.title ?? "").trim();
  const text = (input.text ?? "").trim();
  if (!title && !text) {
    return {
      ok: false,
      code: "EMPTY_CAPTURE",
      message: "The page capture was empty (no title, no text) — nothing to remember.",
    };
  }

  let clients: Awaited<ReturnType<typeof resolveKBClients>>;
  try {
    clients = await resolveKBClients(userId);
  } catch {
    clients = null;
  }
  if (!clients) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message:
        "Remembering pages needs an OnyxBase key — add one in Settings → API Keys (the Knowledge Base is OnyxBase-backed).",
    };
  }

  const content = buildRememberedPageContent(input);
  if (!content.trim() || content.length > MAX_KB_CONTENT_CHARS) {
    return {
      ok: false,
      code: "SAVE_FAILED",
      message: `The remembered page is ${content.length.toLocaleString()} chars — over the ${MAX_KB_CONTENT_CHARS.toLocaleString()}-char Knowledge Base limit.`,
    };
  }

  try {
    const item = await kbSave(clients.kv, userId, {
      title: title || hostnameOf(input.url) || input.url || "Saved page",
      content,
      type: input.type ?? "document",
      category: "web",
      tags: rememberPageTags(input.url),
      source: input.source === "user" ? "user" : "ai",
    });
    return {
      ok: true,
      item,
      contentChars: content.length,
      historyIncluded: input.includeHistory !== false && (input.navLog?.length ?? 0) > 0,
    };
  } catch (e) {
    return {
      ok: false,
      code: "SAVE_FAILED",
      message: `Could not save the page to the Knowledge Base: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
