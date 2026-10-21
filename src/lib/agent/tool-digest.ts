/**
 * Tool-digest injection helpers — PRD §13/§14/§38 (never hallucinate tools).
 *
 * The generated ONYX_MD_DIGEST (onyx-md-digest.ts, from Onyx.md) is injected
 * into EVERY system prompt path so the model always knows its complete tool
 * surface without having to read /home/user/Onyx.md first:
 *
 *   - interactive turns ............ runtime.ts (inside toolKnowledgeBase)
 *   - subagent turns ............... subagent-runtime.ts
 *
 * Injection is idempotent (marker-based) so layered prompts that already
 * contain the digest never duplicate the block. Client- and server-safe: pure string helpers.
 */

import { ONYX_MD_DIGEST } from "./onyx-md-digest";

/** Heading every digest block starts with — the idempotency marker. */
export const TOOL_DIGEST_MARKER = "## TOOL DIGEST";

/** True when the prompt already carries the tool digest. */
export function hasToolDigest(systemPrompt: string): boolean {
  return (systemPrompt ?? "").includes(TOOL_DIGEST_MARKER);
}

/**
 * Append the tool digest to a system prompt unless it is already present.
 * The digest carries its own anti-hallucination availability rules, so this
 * one call is the complete injection.
 */
export function ensureToolDigest(systemPrompt: string): string {
  const base = systemPrompt ?? "";
  return hasToolDigest(base) ? base : `${base}\n\n${ONYX_MD_DIGEST}`;
}

/** UTF-8 byte size (prompt-budget logging — TextEncoder works everywhere). */
export function promptBytes(text: string): number {
  return new TextEncoder().encode(text ?? "").length;
}

/** Kilobytes to one decimal — for size log lines. */
export function promptKb(text: string): number {
  return Math.round(promptBytes(text) / 102.4) / 10;
}
