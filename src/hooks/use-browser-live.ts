"use client";

/**
 * useBrowserLive — the REALTIME browser view transport (PRD §2-§4).
 *
 * While the agent's browser session is active (any use_browser call in the
 * current run is running/pending), this hook opens ONE long-lived SSE
 * stream to /api/sandbox (`browser_live_stream`) and surfaces:
 *
 *   - `phase` — "connecting" (driver booting / no live.json yet),
 *     "live" (state frames flowing), "closed" (driver reported close),
 *     "error" (stream fatal).
 *   - `state` — the driver's live.json snapshot: cursor (viewport px),
 *     current action, url, title, tab, viewport, booted/closed, sessionId.
 *   - `frameUrl` — an object URL of the newest JPEG screencast frame
 *     (previous URLs are revoked automatically).
 *
 * The stream auto-reconnects (1s + jitter) while `enabled` stays true and
 * the server ends it with `bye` (6-minute rotation). Frames and state
 * updates arrive server-polled at ~300ms cadence, so this hook re-renders
 * at most ~3-4×/s and is safe to mount inside a chat message.
 */

import { useEffect, useRef, useState } from "react";
import { getE2BClient } from "@/lib/e2b/client";
import { resolveSandboxApiKey } from "@/lib/e2b/sandbox-rotation";

export interface BrowserLiveState {
  cursor: { x: number; y: number };
  action: string | null;
  seq: number;
  frameSeq: number;
  tab: string | null;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  booted: boolean;
  closed: boolean;
  sessionId: string | null;
  runtime: string | null;
  ts: number;
}

export type BrowserLivePhase = "connecting" | "live" | "closed" | "error";

export interface BrowserLive {
  phase: BrowserLivePhase;
  state: BrowserLiveState | null;
  /** Object URL of the newest frame — revocation handled internally. */
  frameUrl: string | null;
  frameSeq: number;
  error: string | null;
}

const INITIAL: BrowserLive = {
  phase: "connecting",
  state: null,
  frameUrl: null,
  frameSeq: -1,
  error: null,
};

/** base64 → Uint8Array (atob avoids TextEncoder bloat for big frames). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * @param enabled true while the browser session is active — the stream only
 * runs while this is true (mounts clean, aborts clean, reconnects on `bye`).
 */
export function useBrowserLive({ enabled }: { enabled: boolean }): BrowserLive {
  const [live, setLive] = useState<BrowserLive>(INITIAL);
  // Object URL of the current frame — kept in a ref so a new frame revokes
  // the previous one without an extra render pass.
  const frameUrlRef = useRef<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      // Session ended — drop the frame URL (state reset happens on next enable).
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let reconnectTimer: number | null = null;

    const setLiveSafe = (patch: Partial<BrowserLive>) => {
      if (!disposed) setLive((prev) => ({ ...prev, ...patch }));
    };

    const runStream = async (): Promise<void> => {
      let apiKey: string | null = null;
      try {
        apiKey = await resolveSandboxApiKey({});
      } catch {
        apiKey = null;
      }
      if (disposed) return;
      if (!apiKey) {
        setLiveSafe({ phase: "error", error: "No sandbox API key available." });
        return;
      }
      const client = getE2BClient(apiKey, null, "shared");
      let res: Response;
      try {
        res = await client.browserLiveStream(controller.signal);
      } catch (err) {
        if (controller.signal.aborted || disposed) return;
        setLiveSafe({
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!res.ok || !res.body) {
        setLiveSafe({ phase: "error", error: `Stream failed (HTTP ${res.status}).` });
        return;
      }

      // ── SSE parse loop ────────────────────────────────────────────
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawFatal = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep >= 0) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            sep = buffer.indexOf("\n\n");
            // Parse one SSE block: `event: <name>` + `data: <json>`.
            let event = "message";
            const dataLines: string[] = [];
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
              // `: keepalive` comments are ignored.
            }
            if (dataLines.length === 0) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (disposed || controller.signal.aborted) return;
            switch (event) {
              case "hello":
                setLiveSafe({ phase: "connecting", error: null });
                break;
              case "waiting":
                setLiveSafe({ phase: "connecting", error: null });
                break;
              case "state": {
                const s = data as unknown as BrowserLiveState;
                setLiveSafe({
                  phase: s.closed ? "closed" : "live",
                  state: s,
                  error: null,
                });
                break;
              }
              case "frame": {
                const b64 = typeof data.b64 === "string" ? data.b64 : null;
                const frameSeq = typeof data.frameSeq === "number" ? data.frameSeq : -1;
                if (b64) {
                  const blob = new Blob([b64ToBytes(b64) as BlobPart], { type: "image/jpeg" });
                  const url = URL.createObjectURL(blob);
                  if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
                  frameUrlRef.current = url;
                  setLiveSafe({ frameUrl: url, frameSeq });
                }
                break;
              }
              case "bye":
                // Server rotated the stream (6-min cap) — reconnect below.
                return;
              case "fatal": {
                sawFatal = true;
                setLiveSafe({
                  phase: "error",
                  error:
                    typeof data.error === "string"
                      ? data.error
                      : "The live browser stream failed.",
                });
                return;
              }
            }
          }
        }
      } catch {
        // Network drop mid-stream — fall through to reconnect.
      }
      if (disposed || sawFatal) return;
      // Stream ended without fatal — reconnect while still enabled (server
      // `bye` rotation or a transient network drop).
      if (enabledRef.current && !controller.signal.aborted) {
        reconnectTimer = window.setTimeout(() => void runStream(), 1000 + Math.random() * 400);
      }
    };

    // Fresh session → reset the view, then connect.
    setLive(INITIAL);
    void runStream();

    return () => {
      disposed = true;
      controller.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [enabled]);

  return live;
}
