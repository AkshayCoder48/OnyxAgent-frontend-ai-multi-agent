"use client";

import { useEffect } from "react";
import { installGlobalErrorCapture } from "@/lib/client-logger";

/**
 * GlobalErrorCapture — the invisible half of the in-app error logs.
 *
 * Installs the global error nets (window.onerror, unhandled rejections,
 * resource load failures) so NOTHING crashes silently; every capture lands
 * in the log store, which surfaces through the docked Logs panel in the
 * chat workspace (toggle in the chat header). Idempotent — safe under
 * Strict Mode double-effects.
 *
 * The old floating 🐛 collector button/drawer was removed: the chat
 * workspace already ships a full Logs side panel, and a second floating
 * entry point was redundant UI. This component renders nothing.
 */
export function GlobalErrorCapture() {
  useEffect(() => {
    installGlobalErrorCapture();
  }, []);
  return null;
}
