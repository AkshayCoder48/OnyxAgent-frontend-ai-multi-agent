"use client";

import { useMemo, useState } from "react";
import { Brain } from "lucide-react";
import type { ToolCall } from "@/types";
import {
  MemoryChips,
  type MemoryChip,
} from "@/components/assistant-ui/elements/memory-chips";
import { useAuthStore } from "@/stores/auth-store";
import { deleteFile, isOPFSAvailable } from "@/lib/storage/opfs";

/**
 * MemoryChips for the agent's long-term-memory tools (assistant-ui
 * `elements-memory-chips` recipe, wired to the app's real OPFS memory store).
 *
 *  - `memory_save`  → one "added" chip (what it just remembered)
 *  - `memory_list`  → all memories as "existing" chips
 *  - `memory_search`→ the matching memories as "existing" chips
 *
 * The forget button is REAL: it deletes `users/<userId>/memory/<id>.json`
 * from OPFS — the exact file the `memory_save` tool wrote — and only then
 * removes the pill. Failures surface inline (no fake success).
 */

/** Parse a memory tool result into chips. Returns null when nothing usable. */
export function parseMemoryChips(toolCall: ToolCall): MemoryChip[] | null {
  const result = toolCall.result;
  if (result == null) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof result === "object") {
    obj = result as Record<string, unknown>;
  } else if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  if (!obj) return null;
  if (obj.error !== undefined) return null;

  const toChip = (entry: unknown, change: MemoryChip["change"]): MemoryChip | null => {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const text =
      typeof e.content === "string"
        ? e.content
        : typeof e.content_preview === "string"
          ? e.content_preview
          : null;
    if (!id || !text) return null;
    return { id, text, change };
  };

  // memory_save → { id, message, entry: { id, content, … } }
  const entry = obj.entry;
  if (typeof entry === "object" && entry !== null) {
    const chip = toChip(entry, "added");
    if (chip) return [chip];
  }
  // memory_list → { memories: [{ id, content_preview, … }] }
  const memories = obj.memories;
  if (Array.isArray(memories)) {
    const chips = memories
      .map((m) => toChip(m, "existing"))
      .filter((c): c is MemoryChip => c !== null);
    if (chips.length > 0) return chips;
  }
  // memory_search → { results: [{ id, content, … }] }
  const results = obj.results;
  if (Array.isArray(results)) {
    const chips = results
      .map((m) => toChip(m, "existing"))
      .filter((c): c is MemoryChip => c !== null);
    if (chips.length > 0) return chips;
  }
  return null;
}

export function MemoryResult({ toolCall }: { toolCall: ToolCall }) {
  const parsed = useMemo(() => parseMemoryChips(toolCall), [toolCall]);
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!parsed) return null;
  const chips = parsed.filter((c) => !forgotten.has(c.id));

  const handleForget = async (id: string) => {
    if (busy) return; // no double-taps while a delete is in flight
    if (!isOPFSAvailable()) {
      setError("Storage unavailable — could not forget.");
      return;
    }
    setBusy(id);
    setError(null);
    try {
      // Delete the exact file memory_save wrote — the same path the
      // `memory_delete` tool uses, so the agent and this UI agree.
      const userId = useAuthStore.getState().user?.id ?? "local-user";
      await deleteFile(`users/${userId}/memory/${id}.json`);
      setForgotten((prev) => new Set(prev).add(id));
    } catch {
      setError("Could not forget this memory. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (chips.length === 0 && forgotten.size > 0) {
    return (
      <div className="flex items-center gap-1.5 px-1.5 py-2 text-xs text-muted-foreground sm:px-2">
        <Brain className="h-3.5 w-3.5" aria-hidden />
        <span>Forgotten.</span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-1.5 sm:px-2">
      <MemoryChips chips={chips} onForget={handleForget} />
      {busy && <p className="text-[11px] text-muted-foreground">Forgetting…</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
