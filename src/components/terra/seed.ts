import type { Conversation, ModelOption } from "./types";

export const MODELS: ModelOption[] = [
  {
    id: "auto",
    label: "Auto · Router",
    description: "Picks the best profile per message",
  },
  {
    id: "fast",
    label: "Terra Mini · Fast",
    description: "Short, quick answers — greetings and lookups",
  },
  {
    id: "balanced",
    label: "Terra 1.5 · Balanced",
    description: "The default editorial voice",
  },
  {
    id: "deep",
    label: "Terra Deep · Reasoning",
    description: "Thinks step by step, shows its plan",
  },
];

const LIKE_BUTTON_CODE = `import { useState } from "react";
import { Heart } from "lucide-react";

export function LikeButton({ count = 0 }: { count?: number }) {
  const [liked, setLiked] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setLiked((v) => !v)}
      aria-pressed={liked}
      className="flex h-11 items-center gap-2 rounded-full border px-4"
    >
      <Heart className={liked ? "fill-terra text-terra" : "text-muted"} />
      <span className="text-sm tabular-nums">{count + (liked ? 1 : 0)}</span>
    </button>
  );
}`;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TODAY = NOW - 2 * 60 * 60 * 1000;      // seed threads are "this afternoon"
const YESTERDAY = NOW - DAY - 3 * 60 * 60 * 1000;

export const seedConversations: Conversation[] = [
  {
    id: "conv-like-button",
    title: "Like button & Terraform state",
    group: "today",
    separator: "Today · 2:14 PM",
    createdAt: TODAY,
    version: 0,
    messages: [
      {
        id: "msg-seed-1",
        role: "user",
        text: "I'm polishing a small like button for our editorial blog, and while I'm at it I want to double-check how we manage Terraform state. Where do I start?",
        time: "2:14 PM",
      },
      {
        id: "msg-seed-2",
        role: "assistant",
        text: "",
        time: "2:14 PM",
        feedback: null,
        parts: [
          {
            type: "text",
            text: `A like button is a small surface, so it rewards restraint — one piece of state, one gesture, a hint of motion. Here is the shape I would reach for.

1. Keep the state local — a single \`useState\` boolean is all a like needs.
2. Let the icon carry the feedback — a filled heart beats a toast for something this small.
3. Update optimistically — flip the UI at once, then reconcile with the server in the background.`,
          },
          {
            type: "code",
            filename: "LikeButton.tsx",
            language: "tsx",
            code: LIKE_BUTTON_CODE,
          },
          {
            type: "text",
            text: `A few things worth keeping in mind as you polish it:

- One piece of state per concern; resist lifting state early.
- \`aria-pressed\` on the button so screen readers hear the toggle.
- A 44px hit area keeps thumbs happy on mobile.`,
          },
          {
            type: "tool",
            tool: {
              name: "web_search",
              icon: "globe",
              subtitle: "terraform state best practices",
              status: "completed",
              args: `{\n  "query": "terraform state best practices",\n  "max_results": 5\n}`,
              result:
                "1. Use remote state with locking — S3 + DynamoDB, or Terraform Cloud.\n2. Isolate state per environment; never share one file across stages.\n3. Enable versioning on the bucket so rollback stays possible.",
            },
          },
        ],
      },
      {
        id: "msg-seed-3",
        role: "user",
        text: "Good. Should we keep the state file local for now and move it later?",
        time: "2:18 PM",
      },
      {
        id: "msg-seed-4",
        role: "assistant",
        text: "",
        time: "2:18 PM",
        feedback: null,
        parts: [
          {
            type: "text",
            text: `Remote from day one, even for a tiny stack. A local \`terraform.tfstate\` is fine in a sandbox, but the moment two people run \`terraform apply\`, local state drifts silently and someone loses an afternoon reconciling it. Put the state in a versioned S3 bucket with DynamoDB locking — it is a ten-minute setup that saves a whole day later.`,
          },
        ],
      },
    ],
  },
  {
    id: "conv-palette",
    title: "Warm palette contrast check",
    group: "today",
    separator: "Today · 11:02 AM",
    createdAt: TODAY,
    version: 0,
    messages: [
      {
        id: "msg-pal-1",
        role: "user",
        text: "Is terracotta on cream readable enough for body text, or should I keep it for accents?",
        time: "11:02 AM",
      },
      {
        id: "msg-pal-2",
        role: "assistant",
        text: "",
        time: "11:03 AM",
        parts: [
          {
            type: "text",
            text: `For accents only. \`#C4552F\` on \`#FAF6F0\` lands around 4.6:1 — right at the AA edge for large text — but full paragraphs in it will feel loud and tire the eyes. Keep body copy in ink \`#1A1A1A\` and spend the terracotta where a little warmth carries a lot of meaning: numerals, links, small marks.`,
          },
        ],
      },
    ],
  },
  {
    id: "conv-tool-cards",
    title: "Naming conventions for tool cards",
    group: "today",
    separator: "Today · 9:41 AM",
    createdAt: TODAY,
    version: 0,
    messages: [
      {
        id: "msg-tc-1",
        role: "user",
        text: "Should tool cards in the thread show snake_case names or prettier display names?",
        time: "9:41 AM",
      },
      {
        id: "msg-tc-2",
        role: "assistant",
        text: "",
        time: "9:42 AM",
        parts: [
          {
            type: "text",
            text: `Show the raw \`snake_case\` name in mono — it reads as honest, machine-adjacent detail — and put the human summary in the card's subtitle. The mono name becomes quiet texture; the sentence above it does the talking.`,
          },
        ],
      },
    ],
  },
  {
    id: "conv-markdown",
    title: "Refactoring the markdown renderer",
    group: "yesterday",
    separator: "Yesterday · 4:32 PM",
    createdAt: YESTERDAY,
    version: 0,
    messages: [
      {
        id: "msg-md-1",
        role: "user",
        text: "Our markdown renderer is one giant component. How do I break it up without breaking rendering?",
        time: "4:32 PM",
      },
      {
        id: "msg-md-2",
        role: "assistant",
        text: "",
        time: "4:33 PM",
        parts: [
          {
            type: "text",
            text: `Split by block, not by feature. One small component per element — \`p\`, \`ol\`, \`code\` — and a thin map that hands each node to its renderer. The renderer becomes boring, which is exactly what you want from a renderer.`,
          },
        ],
      },
    ],
  },
];

export const EMPTY_STATE_SUGGESTIONS = [
  "Draft a warm welcome email",
  "Explain Terraform remote state",
  "Review my like button component",
];
