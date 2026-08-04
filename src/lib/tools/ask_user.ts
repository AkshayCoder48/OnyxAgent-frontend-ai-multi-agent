"use client";

import { registerTool, type ToolContext } from "./registry";
import type { AskUserQuestion } from "@/types";

/**
 * ask_user — pauses the agent turn and asks the user any number of questions.
 *
 * Mirrors the original `app/agents/tools/ask_user_tool.py`: emits an
 * `ask_user` WSEvent (consumed by `use-chat.ts` to render a question card),
 * waits for the user's answers, and returns them as a structured object so
 * the LLM can continue.
 *
 * The runtime's `waitForAskUser` callback (injected via `ToolContext`) is the
 * actual wait primitive — it dispatches a `CustomEvent` and listens for the
 * matching response event from the UI (see `agent/runtime.ts`).
 *
 * NOTE: The previous `maxItems: 10` limit has been removed — the agent may
 * ask as many questions as needed. The QuestionPrompt UI steps through them
 * one at a time so even a long list stays usable.
 */

interface AskUserArgs {
  questions: Array<{
    question: string;
    options?: string[];
    allow_custom?: boolean;
  }>;
}

registerTool(
  "ask_user",
  "Ask the user a clarifying question. Use when you need information that you cannot reasonably infer from context. Provide any number of questions; for each, you may supply `options` (the user picks one) and `allow_custom` (let the user type a free-form answer). The user may skip any question. The questions are presented one at a time so a long list is fine.",
  {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Predefined choices the user can pick from.",
            },
            allow_custom: {
              type: "boolean",
              description: "Allow the user to type a free-form answer.",
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  async (args: AskUserArgs, ctx: ToolContext) => {
    // Defensively handle args.questions — the AI might pass it as a string,
    // a single object, or an array. Normalize to an array.
    let rawQuestions = args.questions as unknown;
    if (!rawQuestions) {
      return { error: "No questions provided" };
    }
    // If it's a string, try to JSON-parse it
    if (typeof rawQuestions === "string") {
      try {
        rawQuestions = JSON.parse(rawQuestions);
      } catch {
        // Treat as a single question string
        rawQuestions = [{ question: rawQuestions }];
      }
    }
    // If it's a single object (not an array), wrap it
    if (!Array.isArray(rawQuestions) && typeof rawQuestions === "object") {
      rawQuestions = [rawQuestions];
    }
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return { error: "No questions provided" };
    }

    const questions: AskUserQuestion[] = (rawQuestions as Array<Record<string, unknown>>).map((q) => ({
      question: String(q?.question ?? ""),
      options: Array.isArray(q?.options) ? (q.options as string[]) : [],
      allowCustom: Boolean(q?.allow_custom ?? true),
    }));

    if (questions.some((q) => !q.question)) {
      return { error: "Each question must have a 'question' field" };
    }

    if (!ctx.waitForAskUser) {
      return { error: "ask_user is not available in this context" };
    }
    const answers = await ctx.waitForAskUser(questions);
    return {
      answers: answers.map((a, i) => ({
        question: questions[i]?.question ?? "",
        answer: a.answer,
        skipped: a.skipped,
      })),
    };
  },
  false,
  "interaction",
);
