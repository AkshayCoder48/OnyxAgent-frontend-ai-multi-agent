"use client";

import { CodeRoute } from "@/components/code/code-route";

/**
 * OnyxCode — /code (Chat), /code/database (Database), /code/preview
 * (Preview). One optional catch-all route keeps all three tabs on the same
 * component so switching tabs never remounts the shell — the preview iframe
 * and the chat thread stay exactly where they were.
 */
export default function CodePage() {
  return <CodeRoute />;
}
