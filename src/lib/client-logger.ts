/**
 * Client logger — writes every error/warning to the in-app Logs store so
 * failures are diagnosable WITHOUT browser devtools.
 *
 * Usage (anywhere client-side):
 *   import { logError, logWarn, logInfo } from "@/lib/client-logger";
 *   logError("llm", `LLM request failed (HTTP 400)`, {
 *     detail: responseText,                       // full provider error body
 *     context: { provider: "api.x.com", model: "gpt", status: 400 },
 *   });
 *
 * Every message + detail is secret-redacted (API keys, bearer tokens) before
 * it enters the store, and mirrored to the real console so devtools still
 * work when available.
 */

import { useLogStore, type LogEntry, type LogLevel } from "@/stores/log-store";

// ---------------------------------------------------------------------------
// Redaction + truncation
// ---------------------------------------------------------------------------

/** Long-lived secret token shapes (OpenAI-style keys, GitHub PATs, bearers). */
const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|xai-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/** Mask anything that looks like a secret key before it hits storage. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, (m) => `${m.slice(0, 6)}…[redacted]`);
}

/** Cap stored text so one giant HTML error page can't blow the LS quota. */
export function truncateForLog(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (+${text.length - max} chars truncated)`;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Logger entry points
// ---------------------------------------------------------------------------

export interface LogOptions {
  /** Full body / stack / response text. Redacted + truncated automatically. */
  detail?: string | unknown;
  /** Structured chips rendered next to the entry (status, model, provider…). */
  context?: LogEntry["context"];
}

function push(level: LogLevel, source: string, message: string, opts: LogOptions = {}) {
  const msg = redactSecrets(String(message ?? "Unknown error"));
  const detail = opts.detail != null
    ? truncateForLog(redactSecrets(safeStringify(opts.detail)))
    : undefined;
  try {
    useLogStore.getState().addLog({ level, source, message: msg, detail, context: opts.context });
  } catch {
    // Never let logging itself break the app.
  }
  // Mirror to the console so devtools (when available) still show it.
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  fn(`[${source}] ${msg}`, opts.detail != null ? safeStringify(opts.detail) : "");
}

export function logError(source: string, message: string, opts: LogOptions = {}) {
  push("error", source, message, opts);
}

export function logWarn(source: string, message: string, opts: LogOptions = {}) {
  push("warn", source, message, opts);
}

export function logInfo(source: string, message: string, opts: LogOptions = {}) {
  push("info", source, message, opts);
}

// ---------------------------------------------------------------------------
// Global capture — window.onerror + unhandled rejections + resource errors
// ---------------------------------------------------------------------------

let installed = false;

/**
 * Install the global error nets. Idempotent; mounted once from Providers.
 * Catches everything NOT already routed through logError/logWarn:
 *   - uncaught exceptions (window.onerror)
 *   - unhandled promise rejections
 *   - resource load failures (script/img/link — capture phase)
 */
export function installGlobalErrorCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Resource load failure (img/script/link never fired onload): a plain
    // Event whose target is the element, not the window.
    const target = event.target;
    if (target && target !== window && !(event instanceof ErrorEvent)) {
      const el = target as HTMLElement;
      const url =
        (el as HTMLImageElement).currentSrc ||
        (el as HTMLLinkElement).href ||
        (el as HTMLScriptElement).src ||
        "";
      logWarn("network", `Resource failed to load: ${el.tagName?.toLowerCase()}`, {
        detail: url,
      });
      return;
    }
    const errEvent = event as ErrorEvent;
    logError("global", errEvent.message || "Uncaught exception", {
      detail:
        errEvent.error instanceof Error
          ? errEvent.error.stack ?? errEvent.error.message
          : errEvent.message,
      context: {
        file: errEvent.filename?.split("/").slice(-2).join("/") ?? "",
        line: errEvent.lineno ?? 0,
      },
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    logError("global", message, {
      detail: reason instanceof Error ? reason.stack ?? reason.message : reason,
    });
  });
}
