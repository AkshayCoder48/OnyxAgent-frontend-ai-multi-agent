"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Composer } from "@/components/terra/composer";
import { Thread } from "@/components/terra/thread";
import { useTerra } from "@/components/terra/store";
import { CodeEmptyState } from "./code-empty-state";
import { CodeHeader } from "./code-header";
import { DatabasePanel } from "./database-panel";
import { PreviewPanel } from "./preview-panel";

/**
 * The OnyxCode app shell — header + the three primary sections. The chat tab
 * reuses the exact Terra thread/composer once the first message exists;
 * before that it shows the large creation surface with no bottom input.
 *
 * All three sections stay MOUNTED, stacked absolutely, and inactive ones are
 * merely `invisible` (NOT display:none) — switching is instant, scroll
 * positions and panel state survive, and the newly-shown section plays a
 * light enter animation (`.onyx-panel`).
 *
 * RUNTIME LIFECYCLE (one chat = one app project = one temporary runtime):
 *   entering a code chat  → the workspace's preview runtime is rehydrated
 *                           (idempotent ensure; files are the source of truth)
 *   switching code chats  → the previous chat's runtime is stopped, the new
 *                           chat's runtime starts — source files untouched
 *   leaving Code Mode     → the runtime stops (CodeShell unmounts here);
 *                           the workspace itself is preserved
 * A hidden browser tab NEVER stops anything — visibility is not exit.
 */
export function CodeShell() {
  const codeTab = useTerra((s) => s.codeTab);
  const booted = useTerra((s) => s.booted);
  const active = useTerra((s) =>
    s.conversations.find((c) => c.id === s.activeCodeId && c.mode === "code"),
  );

  const hasMessages = (active?.messages.length ?? 0) > 0;
  const workspaceId = active?.id ?? "";
  /** Latest workspace id — maintained by the lifecycle effect, read by the
   *  unmount-only cleanup. */
  const workspaceIdRef = useRef(workspaceId);
  /** The workspace id the lifecycle effect last ran for (chat switches). */
  const prevWorkspaceRef = useRef("");

  /* Runtime stop for a workspace (fire-and-forget, idempotent). */
  const stopRuntime = (id: string) => {
    if (!id) return;
    void fetch("/api/code/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id, action: "stop_workspace" }),
    }).catch(() => undefined);
  };
  /* Runtime rehydration for a workspace (idempotent ensure). */
  const ensureRuntime = (id: string) => {
    if (!id) return;
    void fetch("/api/code/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id, action: "ensure" }),
    }).catch(() => undefined);
  };

  // Chat switch: stop the previous chat's runtime, start the new one's.
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    const previous = prevWorkspaceRef.current;
    prevWorkspaceRef.current = workspaceId;
    if (workspaceId && previous && workspaceId !== previous) {
      stopRuntime(previous);
    }
    if (workspaceId) ensureRuntime(workspaceId);
  }, [workspaceId]);

  // Leaving Code Mode entirely (this shell unmounts): destroy the runtime,
  // keep the workspace. StrictMode double-mount in dev makes this
  // stop→ensure once — harmless (same session id, one revision bump).
  useEffect(
    () => () => {
      stopRuntime(workspaceIdRef.current);
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeHeader />

      <div className="relative min-h-0 flex-1">
        {/* Chat */}
        <section
          data-active={codeTab === "chat"}
          aria-label="Chat"
          className={cn(
            "onyx-panel absolute inset-0 flex flex-col",
            codeTab !== "chat" && "invisible pointer-events-none",
          )}
        >
          <div className="terra-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
            {!booted ? (
              <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-6 px-4 py-10 sm:px-6" aria-hidden>
                <div className="h-3 w-44 rounded-full bg-paper" />
                <div className="h-40 rounded-2xl bg-paper" />
              </div>
            ) : hasMessages ? (
              <Thread />
            ) : (
              <CodeEmptyState workspaceId={workspaceId || undefined} />
            )}
          </div>
          {hasMessages && <Composer />}
        </section>

        {/* Database */}
        <section
          data-active={codeTab === "database"}
          aria-label="Database"
          className={cn(
            "onyx-panel terra-scroll absolute inset-0 flex flex-col overflow-y-auto",
            codeTab !== "database" && "invisible pointer-events-none",
          )}
        >
          <DatabasePanel workspaceId={workspaceId} active={codeTab === "database"} />
        </section>

        {/* Preview */}
        <section
          data-active={codeTab === "preview"}
          aria-label="Preview"
          className={cn(
            "onyx-panel terra-scroll absolute inset-0 flex flex-col overflow-y-auto",
            codeTab !== "preview" && "invisible pointer-events-none",
          )}
        >
          <PreviewPanel workspaceId={workspaceId} active={codeTab === "preview"} />
        </section>
      </div>
    </div>
  );
}
