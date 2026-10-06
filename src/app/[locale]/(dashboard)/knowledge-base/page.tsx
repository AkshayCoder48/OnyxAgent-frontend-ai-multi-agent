"use client";

import { KnowledgeBasePage } from "@/components/knowledge-base/knowledge-base-page";

/**
 * Knowledge Base tab — the user-facing view of the OnyxBase-backed persistent
 * workspace knowledge: AI-saved knowledge items, hosted files, and storage
 * usage. The AI writes here via the `knowledge_base` tool; this page is the
 * manager (browse / search / edit / share), NOT a chat.
 */
export default function KnowledgeBaseTabPage() {
  return <KnowledgeBasePage />;
}
