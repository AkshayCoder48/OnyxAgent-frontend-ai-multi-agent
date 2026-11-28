/**
 * Execution evidence ledger (PRD Issues 1, 2, 7, 8 / Tests D, E, F).
 *
 * WHY THIS EXISTS: the completion check used to be TEXT-ONLY — a response
 * that "read like a final answer" ended the turn, even when the ledger of
 * what ACTUALLY ran said otherwise (the imagedescriber incident: the
 * final report claimed testing that never happened; a 200-result table
 * was fabricated). The PRD requires the completion decision to be
 * evidence-based: what was attempted, what executed, what failed, what
 * was functionally verified.
 *
 * DISTINCTIONS THE LEDGER DRAWS (PRD §Issue-8 vocabulary):
 *   attempted  — a tool call was issued this turn (planned, dispatched or
 *                refused — all are attempts).
 *   executed   — the handler ran and returned a non-error result.
 *   failed     — executed but returned an error (or was refused by
 *                validation / the approval gate / the retry budget).
 *   verified   — executed AND the result carries functional evidence:
 *                the classification below found real verification
 *                signals, not just "no error".
 *
 * HTTP vs FUNCTIONAL success (Issue 7): for web results the ledger
 * classifies evidence strength:
 *   http_ok        — a response arrived with an OK status.
 *   parsed         — the body parsed as JSON.
 *   schema_ok      — expected application fields exist.
 *   functional_ok  — the application-level payload indicates the actual
 *                    operation happened (e.g. a non-empty description
 *                    for image analysis).
 *   placeholder    — the payload looks like placeholder/stub data (the
 *                    exact failure mode of the incident: HTTP 200 with
 *                    base64 placeholder input).
 * HTTP 200 alone NEVER sets functional_ok.
 *
 * The ledger NEVER inspects tool outputs for secrets — it reads only the
 * structured result envelope (status/error code/http_status), and for
 * browser/fetch bodies only shallow, whitelisted fields.
 */

export type EvidenceClass =
  | "http_ok"
  | "parsed"
  | "schema_ok"
  | "functional_ok"
  | "placeholder";

export interface LedgerEntry {
  /** Tool-call id (the idempotency key). */
  id: string;
  tool: string;
  /** attempted | executed | failed — per the PRD's vocabulary. */
  state: "attempted" | "executed" | "failed";
  /** When executed/failed: the strongest evidence found in the result. */
  evidence: EvidenceClass[];
  /** True when the result's error indicates an EXTERNAL blocker
   *  (missing key, permission, unreachable dependency) rather than the
   *  approach being wrong. Drives the BLOCKED completion verdict. */
  externalBlocker: boolean;
  /** One-line, non-sensitive summary (error code / evidence class). */
  note: string;
}

/** Error codes that mean "the environment is missing something", not
 *  "your approach is wrong". Used for the BLOCKED-vs-FAILED verdict. */
const EXTERNAL_BLOCKER_CODES = new Set([
  "browser_startup_failed",
  "TURN_BUDGET_EXHAUSTED",
  "MISSING_API_KEY",
  "E2B_SANDBOX_UNAVAILABLE",
  "approval_denied",
  "sandbox_timeout",
]);

export class ExecutionLedger {
  private entries: LedgerEntry[] = [];

  /** A call was issued. Recording attempt + outcome in one step keeps the
   *  ledger append-only and replay-free (same id never double-records). */
  record(entry: LedgerEntry): void {
    if (this.entries.some((e) => e.id === entry.id)) return;
    this.entries.push(entry);
  }

  get all(): readonly LedgerEntry[] {
    return this.entries;
  }

  get attempted(): number {
    return this.entries.length;
  }
  get executed(): number {
    return this.entries.filter((e) => e.state === "executed").length;
  }
  get failed(): number {
    return this.entries.filter((e) => e.state === "failed").length;
  }
  get verified(): number {
    return this.entries.filter((e) =>
      e.state === "executed" && e.evidence.includes("functional_ok"),
    ).length;
  }
  get blockedExternally(): boolean {
    return this.entries.some((e) => e.externalBlocker);
  }

  /**
   * Classify a completed tool result into evidence classes. `status` is
   * the tool-call status; `result` is the structured payload the handler
   * returned (unknown-shaped — classification is best-effort).
   */
  static classify(result: unknown, status: "completed" | "error"): {
    state: "executed" | "failed";
    evidence: EvidenceClass[];
    externalBlocker: boolean;
    note: string;
  } {
    if (status === "error") {
      const code = readErrorCode(result);
      return {
        state: "failed",
        evidence: [],
        externalBlocker: EXTERNAL_BLOCKER_CODES.has(code),
        note: code ? `failed: ${code}` : "failed",
      };
    }
    const evidence: EvidenceClass[] = [];
    const env = asRecord(result);
    // 1. HTTP layer.
    const httpStatus = readHttpStatus(env);
    if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) evidence.push("http_ok");
    // 2/3. Body layer — parse + shape.
    const body = findBody(env);
    if (body !== undefined) {
      if (looksLikeJson(body)) evidence.push("parsed");
      const brec = asRecord(body);
      if (brec && hasAnyKey(brec, ["code", "data", "descList", "result", "output", "content"])) {
        evidence.push("schema_ok");
      }
      // 4/5. Functional vs placeholder. Placeholder/functional signals
      // may live NESTED (the incident's real shape: data.descList[0].desc),
      // so both checks operate on a bounded flattening of the body.
      if (brec) {
        if (containsPlaceholder(flattenForScan(body))) {
          evidence.push("placeholder");
        } else if (hasMeaningfulData(brec) || hasMeaningfulData(deepFirstList(brec))) {
          evidence.push("functional_ok");
        }
      }
    } else if (hasMeaningfulData(env)) {
      // Non-HTTP tools: a completed result with real content is
      // functional evidence (e.g. read_file with content, browser text).
      evidence.push("functional_ok");
    }
    const note = evidence.length > 0 ? `evidence: ${evidence.join("+")}` : "executed (no evidence signals)";
    return { state: "executed", evidence, externalBlocker: false, note };
  }

  /**
   * The turn-level completion verdict (PRD §Issue-2 completion states).
   * `finalTextLooksComplete` is the existing TEXT heuristic's verdict —
   * the ledger REFINES it, never overrides it toward "better than the
   * truth".
   */
  verdict(): {
    completion: "COMPLETED" | "PARTIALLY_COMPLETED" | "BLOCKED" | "FAILED" | "NOT_STARTED";
    summary: string;
  } {
    if (this.attempted === 0) {
      return { completion: "NOT_STARTED", summary: "no tool executions this turn" };
    }
    if (this.executed === 0 && this.failed > 0) {
      const blocked = this.blockedExternally;
      return {
        completion: blocked ? "BLOCKED" : "FAILED",
        summary: blocked
          ? `${this.failed} attempt(s) all failed on an external blocker (missing key/runtime/permission)`
          : `${this.failed} attempt(s) all failed — no operation executed successfully`,
      };
    }
    if (this.failed > 0) {
      const blocked = this.blockedExternally;
      return {
        completion: blocked ? "PARTIALLY_COMPLETED" : "PARTIALLY_COMPLETED",
        summary: `${this.executed} executed, ${this.failed} failed, ${this.verified} functionally verified`,
      };
    }
    if (this.verified === 0 && this.executed > 0) {
      return {
        completion: "PARTIALLY_COMPLETED",
        summary: `${this.executed} executed but none carried functional verification evidence`,
      };
    }
    return {
      completion: "COMPLETED",
      summary: `${this.executed} executed, ${this.verified} functionally verified, 0 failed`,
    };
  }
}

// ── classification helpers (shallow + whitelisted, never deep-dumping) ──

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function readErrorCode(result: unknown): string {
  const env = asRecord(result);
  if (!env) return "";
  const err = asRecord(env.error);
  if (err) {
    // Structured codes come in two dialects: code (TS tools) and type
    // (the browser driver's error envelope).
    if (typeof err.code === "string") return err.code;
    if (typeof err.type === "string") return err.type;
  }
  if (typeof env.error === "string") return env.error.slice(0, 60);
  return "";
}

/** Bounded flattening for signal scanning: concatenate the STRING values
 *  found in the body up to depth 4 / 64 strings — enough to catch the
 *  incident's nested descList[0].desc placeholder, never a full dump. */
function flattenForScan(body: unknown, depth = 0, acc: string[] = []): string {
  if (depth > 4 || acc.length > 64) return acc.join(" ");
  if (typeof body === "string") {
    acc.push(body);
  } else if (Array.isArray(body)) {
    for (const v of body) flattenForScan(v, depth + 1, acc);
  } else if (body !== null && typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      flattenForScan(v, depth + 1, acc);
    }
  }
  return acc.join(" ");
}

/** Find the first nested list of records (e.g. descList) so meaningful-
 *  data detection sees the REAL payload shape, not only the envelope. */
function deepFirstList(rec: Record<string, unknown>, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  for (const v of Object.values(rec)) {
    if (Array.isArray(v) && v.length > 0 && asRecord(v[0])) {
      return asRecord(v[0]);
    }
    const nested = asRecord(v);
    if (nested) {
      const found = deepFirstList(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function readHttpStatus(env: Record<string, unknown> | null): number | null {
  if (!env) return null;
  for (const k of ["http_status", "status_code", "httpStatus", "statusCode", "http_code"]) {
    const v = env[k];
    if (typeof v === "number") return v;
  }
  return null;
}

/** Find the response body in common envelope shapes (browser capture,
 *  web_fetch, api tool results) without deep traversal. */
function findBody(env: Record<string, unknown> | null): unknown {
  if (!env) return undefined;
  if (env.body !== undefined) return env.body;
  if (env.data !== undefined) return env.data;
  if (env.json !== undefined) return env.json;
  if (env.response !== undefined) return env.response;
  if (env.result !== undefined) return env.result;
  return undefined;
}

function looksLikeJson(body: unknown): boolean {
  if (typeof body === "object") return true;
  if (typeof body === "string") {
    const t = body.trim();
    return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  }
  return false;
}

function hasAnyKey(rec: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => rec[k] !== undefined && rec[k] !== null);
}

/** Placeholder heuristics — the exact incident: a 200 whose payload came
 *  from stub/placeholder input (base64 test data, "placeholder", "test",
 *  "dummy", "lorem", "sample"). Only shallow string checks, never a dump. */
function containsPlaceholder(body: unknown): boolean {
  const s = typeof body === "string" ? body.toLowerCase().slice(0, 2000) : "";
  if (!s) return false;
  return (
    /\bplaceholder\b/.test(s) ||
    /\bnot[ _-]?implemented\b/.test(s) ||
    /\bstubbed?\b/.test(s) ||
    /\bmock(ed)? (data|response)\b/.test(s)
  );
}

/** Functional evidence: the payload carries REAL application output —
 *  non-empty content strings/descriptions, non-empty result lists. */
function hasMeaningfulData(rec: Record<string, unknown>): boolean {
  for (const k of ["descList", "descriptions", "results", "items", "output", "content", "text", "desc", "description", "plainText", "mdDesc"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim().length >= 8) return true;
    if (Array.isArray(v) && v.length > 0) {
      // A list of records with any non-empty string field = real data.
      const first = asRecord(v[0]);
      if (first) {
        const hasText = Object.values(first).some(
          (x) => typeof x === "string" && x.trim().length >= 4,
        );
        if (hasText) return true;
      } else if (typeof v[0] === "string" && (v[0] as string).trim().length >= 4) {
        return true;
      }
    }
  }
  return false;
}
