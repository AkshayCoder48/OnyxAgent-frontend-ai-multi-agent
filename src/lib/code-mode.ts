"use client";

/**
 * OnyxCode Code Mode — imperative (non-React) mode flag.
 *
 * Code Mode is a thin UI + tool layer over the SAME agent runtime (PRD):
 * the /code routes render the same ChatWorkspace / ChatContainer, the same
 * providers, tools, skills and sandbox. This module is the single source of
 * truth for NON-REACTIVE consumers (the agent runtime's lazy
 * `conversationService.create` call sites) that need to know whether the
 * turn that is starting belongs to Code Mode, so freshly created
 * conversations get stamped `mode: "code"`.
 *
 * React components should NOT read this flag for rendering — they get the
 * mode via props from the route they live under. The flag is set by the
 * /code layout (mount = true, unmount = false).
 */

let codeModeActive = false;

/** True while the user is inside the /code Code Mode routes. */
export function isCodeMode(): boolean {
  return codeModeActive;
}

/** Set by the /code layout — mirrors "the user is on a Code Mode route". */
export function setCodeMode(active: boolean): void {
  codeModeActive = active;
}

/** localStorage key remembering the last normal-Agent conversation id, so
 *  leaving Code Mode can restore the agent chat the user was in. */
export const LAST_AGENT_CONVERSATION_KEY = "onyx:last-agent-conversation";

export function rememberAgentConversation(id: string | null | undefined): void {
  try {
    if (id) window.localStorage.setItem(LAST_AGENT_CONVERSATION_KEY, id);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function recallAgentConversation(): string | null {
  try {
    return window.localStorage.getItem(LAST_AGENT_CONVERSATION_KEY);
  } catch {
    return null;
  }
}
