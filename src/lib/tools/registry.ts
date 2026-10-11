"use client";

/**
 * Tool registry — the central catalog of agent-callable tools.
 *
 * Each tool is registered with:
 *   - `name` — the OpenAI function name (must be unique).
 *   - `description` — surfaced to the LLM.
 *   - `parameters` — JSON Schema object the LLM uses to construct args.
 *   - `handler(args, ctx)` — async function executed when the LLM invokes it.
 *   - `requires_approval` — when true, the runtime emits a
 *     `tool_approval_required` event and waits for a HITL decision before
 *     invoking the handler (used for dangerous tools like `run_terminal`).
 *
 * `list(ctx)` returns the tools available for a given context — currently
 * everything registered, but the seam is here so per-user filtering (e.g.
 * MCP tools, custom tools, skills) can hook in without changing call sites.
 *
 * Circular-import note: tool implementation files import `registerTool` from
 * this module, and this module doesn't import them — registration is a
 * side-effect that happens once at app boot via `tools/index.ts`. That keeps
 * the dependency graph acyclic.
 */

import type { AskUserQuestion, WSEvent } from "@/types";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Active user id. */
  userId: string;
  /** Active conversation id (set by the runtime at turn start). */
  conversationId?: string;
  /** Emit a WSEvent to the consumer (used by ask_user + tool_call). */
  emit: (event: WSEvent) => void;
  /** Caller's abort signal — tools should respect this. */
  signal?: AbortSignal;
  /** Ask the user a question and wait for an answer (ask_user tool). */
  waitForAskUser?: (
    questions: AskUserQuestion[],
  ) => Promise<Array<{ answer: string; skipped: boolean }>>;
  /** Decrypted E2B sandbox API key (lazily provided by services layer).
   *  Legacy field name `e2bApiKey` is kept for back-compat with existing
   *  tool implementations; new code can use `sandboxApiKey` instead. */
  e2bApiKey?: string;
  /** Alias for `e2bApiKey` — the decrypted E2B sandbox API key. */
  sandboxApiKey?: string;
  /** Sandbox allocation mode: "shared" (one sandbox for all conversations)
   *  or "separate" (one sandbox per conversation). */
  sandboxMode?: "shared" | "separate";
  /** Decrypted AI provider API key (used by some tools). */
  aiApiKey?: string;
  /** Env vars dict for the sandbox (already decrypted). */
  envVars?: Record<string, string>;
  /** Per-user settings (system prompt, etc.). */
  settings?: Record<string, unknown>;
  /**
   * Streaming output callback — used by long-running tools (run_python,
   * run_terminal) to emit stdout/stderr chunks in real time. The runtime
   * pipes these into `tool_output` WSEvents so the chat UI can render live
   * output as it arrives instead of waiting for the tool to finish.
   */
  onToolOutput?: (
    toolCallId: string,
    output: string,
    type: "stdout" | "stderr" | "prompt",
  ) => void;
}

export type ToolHandler<TArgs = Record<string, unknown>, TResult = unknown> = (
  args: TArgs,
  ctx: ToolContext,
) => Promise<TResult>;

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler<TArgs>;
  /** When true, the runtime will request HITL approval before invoking. */
  requires_approval?: boolean;
  /** Optional category for the catalog UI. */
  category?: string;
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

const _registry = new Map<string, ToolDefinition>();
const _order: string[] = [];

/**
 * Register a tool. Idempotent for re-registration (HMR / StrictMode
 * double-mount): a tool with the same name keeps its FIRST registration.
 * To REPLACE a tool's definition/handler use `updateTool` (below).
 */
export function registerTool<TArgs = Record<string, unknown>>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: ToolHandler<TArgs>,
  requires_approval = false,
  category = "general",
): void {
  if (_registry.has(name)) {
    // Idempotent re-register (HMR / StrictMode double-mount) — keep first
    // registration. Avoids throwing during development.
    return;
  }
  _registry.set(name, {
    name,
    description,
    parameters,
    handler: handler as ToolHandler,
    requires_approval,
    category,
  });
  _order.push(name);
}

/**
 * Update an EXISTING tool's definition in place (same registry slot, same
 * position). Used by the custom-tool edit flow (manage_custom_tool action
 * "edit") — previously edit re-called registerTool, which was a silent
 * NO-OP for already-registered names (first-wins), so edits never reached
 * the model-visible tool list until a reload. Throws when the tool is not
 * registered (call registerTool first).
 */
export function updateTool(
  name: string,
  def: Partial<Omit<ToolDefinition, "name">>,
): void {
  const existing = _registry.get(name);
  if (!existing) {
    throw new Error(`updateTool: '${name}' is not registered`);
  }
  _registry.set(name, {
    ...existing,
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.parameters !== undefined ? { parameters: def.parameters } : {}),
    ...(def.handler !== undefined ? { handler: def.handler as ToolHandler } : {}),
    ...(def.requires_approval !== undefined ? { requires_approval: def.requires_approval } : {}),
    ...(def.category !== undefined ? { category: def.category } : {}),
  });
}

/**
 * Unregister a tool (custom-tool delete flow). The tool disappears from
 * `listTools()` — the model-visible tool list AND the executor surface —
 * immediately. Registering the same name again later works (fresh slot,
 * appended in registration order).
 */
export function unregisterTool(name: string): boolean {
  const deleted = _registry.delete(name);
  if (deleted) {
    const i = _order.indexOf(name);
    if (i !== -1) _order.splice(i, 1);
  }
  return deleted;
}

/** Get a single tool by name (or undefined). */
export function getTool(name: string): ToolDefinition | undefined {
  return _registry.get(name);
}

/** List all registered tools in registration order. */
export function listTools(_ctx?: ToolContext): ToolDefinition[] {
  return _order.map((n) => _registry.get(n)!).filter(Boolean);
}

/** True if a tool with the given name is registered. */
export function hasTool(name: string): boolean {
  return _registry.has(name);
}

/** Clear the registry — used in tests / hot reloads. */
export function clearTools(): void {
  _registry.clear();
  _order.length = 0;
}
