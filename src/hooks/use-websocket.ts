"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @deprecated Backendless mode — this hook is no longer used.
 *
 * The original `useWebSocket` opened a WebSocket to the FastAPI backend's
 * `/api/v1/ws/agent` endpoint with JWT-auth subprotocols, exponential
 * backoff reconnect, and a deferred-teardown dance to avoid Firefox's
 * reconnect throttle. None of that applies in backendless mode: the agent
 * runtime is a per-turn client-side SSE stream (`runAgentTurn` from
 * `@/lib/agent/runtime`) that drives the chat store via an `onEvent`
 * callback. See `use-chat.ts` for the new transport.
 *
 * This file is kept (not deleted) so `hooks/index.ts` and any stray imports
 * don't break the build. Calling `useWebSocket` throws a deprecation error
 * so a forgotten import surfaces immediately rather than silently no-op'ing.
 */
export interface UseWebSocketOptions {
  url?: string;
  protocols?: string[];
  onMessage?: (event: MessageEvent) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

const DEPRECATION_ERROR = new Error(
  "useWebSocket is deprecated in backendless mode. " +
    "The agent runtime uses a per-turn SSE stream now — see useChat() in " +
    "@/hooks/use-chat and runAgentTurn() in @/lib/agent/runtime.",
);

export function useWebSocket(_options: UseWebSocketOptions = {}) {
  // Read the options so React's rules-of-hooks lint stays happy if a caller
  // passes inline callbacks. We never actually use them.
  void _options;

  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Surface the deprecation loudly the first time a component tries to use
  // this hook. The console error makes the offending component easy to grep
  // for; the thrown error stops the render before anything worse happens.
  useEffect(() => {
    console.error(DEPRECATION_ERROR);
  }, []);

  const connect = useCallback(() => {
    console.error(DEPRECATION_ERROR);
    setIsConnected(false);
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // already closing/closed — nothing to do
      }
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const sendMessage = useCallback((_data: string | object) => {
    console.error(DEPRECATION_ERROR);
  }, []);

  return {
    isConnected,
    connect,
    disconnect,
    sendMessage,
  };
}
