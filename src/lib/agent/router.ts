/**
 * Terra model router — decides which execution profile handles a request.
 *
 * The gateway serves one upstream model (glm-4-plus); what we actually steer
 * is the execution envelope: thinking mode, context window, system voice and
 * the visible-reasoning protocol. "Auto (router)" analyses the prompt and
 * picks the cheapest profile that still answers well; manual picks pin a
 * profile. Every decision carries a human-readable reason so the UI can show
 * exactly why a route was taken.
 */

export type RouteName = "fast" | "balanced" | "deep";
export type ModelPreference = "auto" | RouteName;

export interface RouteSignal {
  id: string;
  label: string;
  weight: number;
}

export interface RouteDecision {
  route: RouteName;
  /** Display name of the chosen profile, e.g. "Terra Deep · Reasoning" */
  label: string;
  /** Upstream model id (informational — the gateway resolves it) */
  model: string;
  /** Human-readable explanation shown on the message chip */
  reason: string;
  /** Signals that fired, strongest first (capped for the UI) */
  signals: RouteSignal[];
  /** Whether upstream thinking mode is enabled */
  thinking: boolean;
  /** How many history messages to include */
  historyWindow: number;
  /** System prompt for the run */
  systemPrompt: string;
  /** Ask the model to open with a private reasoning plan */
  reasoningProtocol: boolean;
}

export interface RouterMessage {
  role: "user" | "assistant";
  content: string;
}

interface RouteProfile {
  label: string;
  thinking: boolean;
  historyWindow: number;
  reasoningProtocol: boolean;
  systemPrompt: string;
}

const BASE_VOICE =
  "You are Terra, a warm, editorial AI assistant. Answer with well-structured markdown: a short intro sentence, ordered steps when giving instructions, a code example when relevant, and a short check-list of tips. Use inline code for identifiers.";

const PROFILES: Record<RouteName, RouteProfile> = {
  fast: {
    label: "Terra Mini · Fast",
    thinking: false,
    historyWindow: 6,
    reasoningProtocol: false,
    systemPrompt:
      "You are Terra, a warm, editorial AI assistant. Answer fast and straight to the point — at most a few sentences, minimal markdown, no preamble. If the answer is a single word or line, give exactly that.",
  },
  balanced: {
    label: "Terra 1.5 · Balanced",
    thinking: false,
    historyWindow: 10,
    reasoningProtocol: false,
    systemPrompt: BASE_VOICE,
  },
  deep: {
    label: "Terra Deep · Reasoning",
    thinking: true,
    historyWindow: 12,
    reasoningProtocol: true,
    systemPrompt: `${BASE_VOICE}

Begin your entire reply with a line that says exactly THINKING: followed on the same or next lines by a brief private plan of 3-8 sentences describing how you will approach the answer. Then a line that says exactly ANSWER: followed by the final answer in clean markdown. Never mention the plan or these markers inside the answer itself.`,
  },
};

export const REASONING_OPEN = "THINKING:";
export const REASONING_CLOSE = "ANSWER:";

const GREETING_RE = /^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|cool|great|nice|perfect|got it|np|done)\b[\s!,.?]*$/i;
const QUICK_RE = /\b(quick(ly)?|brief(ly)?|tl;?dr|short answer|one[- ]liner|in short|just (tell|say|give)|simple question)\b/i;
const CODE_RE = /```|`[^`\n]+`|\b(function|const|class|import|export|component|hook|typescript|javascript|python|tsx|css|sql|regex|bug|error|stack ?trace|compile|deploy|refactor|debug)\b/i;
const COMPLEX_RE = /\b(why|how does|how would|explain|compare|contrast|analy[sz]e|architect|design|trade[- ]?offs?|pros and cons|prove|derive|optimi[sz]e|scal(e|ing|ability)|evaluate|reason(ing)? about|think (about|through|step)|step by step|walk me through|strategy|plan)\b/i;
const MATH_RE = /(\d+\s*[+\-*/^%]\s*\d+)|(\b\d+\s*(million|billion|%)\b)|(\bsolve\b|\bequation\b|\bprobability\b|\bderivative\b|\bintegral\b)/i;
const URL_RE = /https?:\/\/\S+/i;
const MULTI_QUESTION_RE = /\?[^?]*\?/;

/**
 * Pure scoring router. Preference "auto" lets the signals decide; any other
 * value pins that route (the reason notes the manual override).
 */
export function routeRequest(
  messages: RouterMessage[],
  preference: ModelPreference = "auto",
): RouteDecision {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser?.content ?? "";
  const trimmed = text.trim();
  const signals: RouteSignal[] = [];
  let score = 0;

  if (preference !== "auto") {
    return {
      ...buildDecision(preference),
      reason: `Pinned manually to ${PROFILES[preference].label}.`,
      signals: [{ id: "manual", label: "Manual selection", weight: 0 }],
    };
  }

  if (GREETING_RE.test(trimmed) && trimmed.length <= 40) {
    signals.push({ id: "greeting", label: "Short greeting / acknowledgment", weight: -3 });
    score -= 3;
  }
  if (QUICK_RE.test(trimmed)) {
    signals.push({ id: "quick", label: "Asks for a quick answer", weight: -2 });
    score -= 2;
  }
  if (trimmed.length >= 200) {
    signals.push({ id: "long", label: `Long prompt (${trimmed.length} chars)`, weight: 2 });
    score += 2;
  } else if (trimmed.length >= 80) {
    signals.push({ id: "medium", label: "Substantive prompt", weight: 1 });
    score += 1;
  }
  if (CODE_RE.test(trimmed)) {
    signals.push({ id: "code", label: "Code / technical artifacts", weight: 2 });
    score += 2;
  }
  if (COMPLEX_RE.test(trimmed)) {
    signals.push({ id: "complex", label: "Analysis / explanation verbs", weight: 2 });
    score += 2;
  }
  if (MATH_RE.test(trimmed)) {
    signals.push({ id: "math", label: "Quantitative reasoning", weight: 2 });
    score += 2;
  }
  if (MULTI_QUESTION_RE.test(trimmed)) {
    signals.push({ id: "multi", label: "Multiple questions at once", weight: 1 });
    score += 1;
  }
  if (URL_RE.test(trimmed)) {
    signals.push({ id: "url", label: "References a link", weight: 1 });
    score += 1;
  }
  const userTurns = messages.filter((m) => m.role === "user").length;
  if (userTurns >= 6) {
    signals.push({ id: "history", label: "Long conversation to synthesise", weight: 1 });
    score += 1;
  }

  const route: RouteName = score >= 4 ? "deep" : score <= 0 ? "fast" : "balanced";
  const profile = PROFILES[route];
  const top = [...signals].sort((a, b) => b.weight - a.weight).slice(0, 3);
  const reason =
    top.length > 0
      ? `Routed to ${profile.label} — ${top.map((s) => s.label.toLowerCase()).join(", ")}.`
      : `Routed to ${profile.label} — plain conversational prompt.`;

  return { ...buildDecision(route), reason, signals };
}

function buildDecision(route: RouteName): RouteDecision {
  const profile = PROFILES[route];
  return {
    route,
    label: profile.label,
    model: "glm-4-plus",
    reason: "",
    signals: [],
    thinking: profile.thinking,
    historyWindow: profile.historyWindow,
    systemPrompt: profile.systemPrompt,
    reasoningProtocol: profile.reasoningProtocol,
  };
}

/**
 * Split a deep-route reply into (reasoning, answer) honoring the
 * THINKING: / ANSWER: line-marker protocol. Designed for streaming: calling
 * it on the accumulated text is idempotent, and a missing ANSWER marker
 * simply means "still thinking".
 */
export function splitThinking(raw: string): { reasoning: string; answer: string } {
  const openMatch = /^\s{0,3}[*_#>\s]*THINKING\s*:?\s*/i.exec(raw);
  if (!openMatch) return { reasoning: "", answer: raw };
  const body = raw.slice(openMatch[0].length);
  const lines = body.split("\n");
  const reasoningLines: string[] = [];
  const answerLines: string[] = [];
  let inAnswer = false;
  for (const line of lines) {
    const clean = line
      .replace(/^[*_#>\s]+/, "")
      .replace(/[*_\s]+$/, "")
      .toUpperCase()
      .replace(/\s+/g, " ");
    if (!inAnswer && (clean === "ANSWER" || clean === "ANSWER:" || clean.startsWith("ANSWER:"))) {
      inAnswer = true;
      const inline = /^\s{0,3}[*_#>\s]*ANSWER\s*:?\s*/i.exec(line);
      const rest = inline ? line.slice(inline[0].length) : "";
      if (rest) answerLines.push(rest);
      continue;
    }
    (inAnswer ? answerLines : reasoningLines).push(line);
  }
  return {
    reasoning: reasoningLines.join("\n").trim(),
    answer: answerLines.join("\n").trim(),
  };
}
