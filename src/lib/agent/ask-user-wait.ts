"use client";

/**
 * ask_user wait — emit the `ask_user` WSEvent and wait for the browser's
 * answer CustomEvent.
 *
 * Extracted from runtime.ts so BOTH the in-browser runtime and the
 * subagent dispatch sites can use the exact same mechanism (the handler
 * runs in the browser with this waiter wired to the live chat UI).
 */

import type { AskUserQuestion, WSEvent } from "@/types";

export const ASK_USER_RESPONSE_EVENT = "agent:ask-user-response";

/** Default wait for a subagent-issued ask_user: the question may land in a
 *  conversation with NO live execution (makeSubagentEmit's no-op path) —
 *  nobody is watching, nobody answers, and the subagent used to hang on
 *  this promise FOREVER (one of the "stalls after 2-3 tool calls" faces).
 *  After this long, resolve as skipped so the subagent proceeds honestly. */
export const SUBAGENT_ASK_USER_TIMEOUT_MS = 300_000;

export function waitForAskUser(
  questions: AskUserQuestion[],
  emit: (e: WSEvent) => void,
  signal?: AbortSignal,
  /** Bounded wait (subagent lane): resolve as skipped when nobody answers.
   *  Undefined (the main agent's lane) waits indefinitely — a human is
   *  watching that chat. */
  timeoutMs?: number,
): Promise<Array<{ answer: string; skipped: boolean }>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answers: Array<{ answer: string; skipped: boolean }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answers);
    };
    const cleanup = () => {
      window.removeEventListener(ASK_USER_RESPONSE_EVENT, handler);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (timer !== undefined) clearTimeout(timer);
    };
    const handler = (event: Event) => {
      const ce = event as CustomEvent<{
        answers: Array<{ answer: string; skipped: boolean }>;
      }>;
      if (!ce.detail?.answers) return;
      finish(ce.detail.answers);
    };
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        finish(questions.map(() => ({ answer: "", skipped: true })));
      };
      signal.addEventListener("abort", abortListener);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(questions.map(() => ({ answer: "", skipped: true }))),
        timeoutMs,
      );
    }
    window.addEventListener(ASK_USER_RESPONSE_EVENT, handler);

    emit({
      type: "ask_user",
      data: {
        questions: questions.map((q) => ({
          question: q.question,
          options: q.options,
          allow_custom: q.allowCustom,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  });
}
