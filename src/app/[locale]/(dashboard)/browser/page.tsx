"use client";

import { BrowserTabPage } from "@/components/browser/browser-tab-page";

/**
 * Browser tab — ONE view of the browser interaction of every available
 * agent: chat agents + project agents (live SSE screencasts of their E2B
 * sandbox browsers) — every agent gets its own live browser view
 * research — they don't run sandbox browsers).
 *
 * Client-only by design (mirrors the knowledge-base page-loading
 * pattern): all data lives in Dexie/IndexedDB behind the conversation,
 * projects services, which only exist in the browser.
 */
export default function BrowserPage() {
  return <BrowserTabPage />;
}
