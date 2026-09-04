"use client";

/**
 * ask_user wait — emit the `ask_user` WSEvent and wait for the browser's
 * answer CustomEvent.
 *
 * Extracted from runtime.ts so BOTH the in-browser runtime and the
 * background-turn browser-tool bridge can use the exact same mechanism
 * (the background runner calls ask_user as a BRIDGED tool — the handler
 * runs in the browser with this waiter wired to the live chat UI).
 */

import type { AskUserQuestion, WSEvent } from "@/types";

export const ASK_USER_RESPONSE_EVENT = "agent:ask-user-response";

export function waitForAskUser(
  questions: AskUserQuestion[],
  emit: (e: WSEvent) => void,
  signal?: AbortSignal,
): Promise<Array<{ answer: string; skipped: boolean }>> {
  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener(ASK_USER_RESPONSE_EVENT, handler);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    };
    const handler = (event: Event) => {
      const ce = event as CustomEvent<{
        answers: Array<{ answer: string; skipped: boolean }>;
      }>;
      if (!ce.detail?.answers) return;
      cleanup();
      resolve(ce.detail.answers);
    };
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        cleanup();
        resolve(questions.map(() => ({ answer: "", skipped: true })));
      };
      signal.addEventListener("abort", abortListener);
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
