"use client";

import { Composer } from "@/components/terra/composer";
import { Thread } from "@/components/terra/thread";
import { useTerra } from "@/components/terra/store";
import type { CodeTab } from "@/components/terra/types";
import { CodeEmptyState } from "./code-empty-state";
import { CodeHeader } from "./code-header";
import { DatabasePanel } from "./database-panel";
import { PreviewPanel } from "./preview-panel";

/**
 * The OnyxCode app shell — header + the three primary tabs. The chat tab
 * reuses the exact Terra thread/composer once the first message exists;
 * before that it shows the large creation surface with no bottom input.
 *
 * `tab` is the URL-derived tab (route-driven). It falls back to the store's
 * tab when the shell is rendered outside the /code* routes.
 */
export function CodeShell({ tab }: { tab?: CodeTab }) {
  const storeTab = useTerra((s) => s.codeTab);
  const codeTab = tab ?? storeTab;
  const booted = useTerra((s) => s.booted);
  const active = useTerra((s) =>
    s.conversations.find((c) => c.id === s.activeCodeId && c.mode === "code"),
  );

  const hasMessages = (active?.messages.length ?? 0) > 0;
  const workspaceId = active?.id ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeHeader tab={tab} />

      {codeTab === "chat" && (
        <>
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
        </>
      )}

      {codeTab === "database" && <DatabasePanel workspaceId={workspaceId} />}
      {codeTab === "preview" && <PreviewPanel workspaceId={workspaceId} />}
    </div>
  );
}
