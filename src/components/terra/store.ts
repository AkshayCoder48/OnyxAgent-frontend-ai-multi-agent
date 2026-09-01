import { create } from "zustand";
import { MODELS, seedConversations } from "./seed";
import type { ChatHistoryMessage, Conversation, Message, MessagePart } from "./types";

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function makeId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

function partContent(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "code":
      return `\`\`\`${part.language}\n${part.code}\n\`\`\``;
    case "tool":
      return `[used tool ${part.tool.name}: ${part.tool.subtitle}]`;
  }
}

function messageContent(message: Message): string {
  if (message.role === "user") return message.text;
  return (message.parts ?? [{ type: "text", text: message.text }])
    .map(partContent)
    .join("\n\n");
}

async function requestReply(
  history: ChatHistoryMessage[],
): Promise<{ text: string } | { error: string }> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-8) }),
    });
    const data = (await response.json()) as { text?: string; error?: string };
    if (!response.ok || data.error) {
      return { error: data.error ?? "Something went wrong — please try again." };
    }
    return { text: data.text ?? "" };
  } catch {
    return { error: "I could not reach the server — check your connection and try again." };
  }
}

interface TerraState {
  conversations: Conversation[];
  activeId: string;
  modelId: string;
  search: string;
  sending: boolean;
  mobileNavOpen: boolean;
  settingsOpen: boolean;
  setActive: (id: string) => void;
  newConversation: () => void;
  setSearch: (query: string) => void;
  setModel: (modelId: string) => void;
  setMobileNav: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setFeedback: (messageId: string, value: "up" | "down") => void;
  send: (text: string) => Promise<void>;
  regenerate: () => Promise<void>;
}

function appendAssistantReply(
  conversations: Conversation[],
  conversationId: string,
  result: { text: string } | { error: string },
): Conversation[] {
  const assistant: Message = {
    id: makeId(),
    role: "assistant",
    text: "",
    time: nowLabel(),
    feedback: null,
    isError: "error" in result,
    parts: [{ type: "text", text: "error" in result ? result.error : result.text }],
  };
  return conversations.map((c) =>
    c.id === conversationId ? { ...c, messages: [...c.messages, assistant] } : c,
  );
}

export const useTerra = create<TerraState>()((set, get) => ({
  conversations: seedConversations,
  activeId: seedConversations[0].id,
  modelId: MODELS[0].id,
  search: "",
  sending: false,
  mobileNavOpen: false,
  settingsOpen: false,

  setActive: (id) => set({ activeId: id }),

  newConversation: () =>
    set((state) => {
      const conversation: Conversation = {
        id: makeId(),
        title: "New conversation",
        group: "today",
        separator: `Today · ${nowLabel()}`,
        messages: [],
      };
      return {
        conversations: [conversation, ...state.conversations],
        activeId: conversation.id,
        mobileNavOpen: false,
      };
    }),

  setSearch: (search) => set({ search }),

  setModel: (modelId) => set({ modelId }),

  setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setFeedback: (messageId, value) =>
    set((state) => ({
      conversations: state.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: m.feedback === value ? null : value } : m,
        ),
      })),
    })),

  send: async (text) => {
    const trimmed = text.trim();
    const state = get();
    if (!trimmed || state.sending) return;
    const conversation = state.conversations.find((c) => c.id === state.activeId);
    if (!conversation) return;

    const userMessage: Message = {
      id: makeId(),
      role: "user",
      text: trimmed,
      time: nowLabel(),
    };
    const title =
      conversation.title === "New conversation" ? titleFrom(trimmed) : conversation.title;
    const conversations = state.conversations.map((c) =>
      c.id === conversation.id ? { ...c, title, messages: [...c.messages, userMessage] } : c,
    );
    set({ conversations, sending: true });

    const history: ChatHistoryMessage[] = (conversations.find(
      (c) => c.id === conversation.id,
    )?.messages ?? []).map((m) => ({ role: m.role, content: messageContent(m) }));

    const result = await requestReply(history);
    set((s) => ({
      conversations: appendAssistantReply(s.conversations, conversation.id, result),
      sending: false,
    }));
  },

  regenerate: async () => {
    const state = get();
    if (state.sending) return;
    const conversation = state.conversations.find((c) => c.id === state.activeId);
    if (!conversation || conversation.messages.length === 0) return;

    const messages = [...conversation.messages];
    while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.pop();
    }
    if (messages.length === 0) return;

    set({
      conversations: state.conversations.map((c) =>
        c.id === conversation.id ? { ...c, messages } : c,
      ),
      sending: true,
    });

    const history: ChatHistoryMessage[] = messages.map((m) => ({
      role: m.role,
      content: messageContent(m),
    }));

    const result = await requestReply(history);
    set((s) => ({
      conversations: appendAssistantReply(s.conversations, conversation.id, result),
      sending: false,
    }));
  },
}));
