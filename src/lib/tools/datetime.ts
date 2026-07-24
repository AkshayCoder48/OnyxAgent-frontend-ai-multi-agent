"use client";

import { registerTool } from "./registry";

/**
 * current_datetime — returns the current UTC date/time in ISO 8601.
 * Mirrors `app/agents/assistant.py`'s `current_datetime` plain tool.
 */

registerTool(
  "current_datetime",
  "Get the current UTC date and time in ISO 8601 format. Use this whenever the user asks about 'today', 'now', or any time-relative concept.",
  {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async () => {
    const now = new Date();
    return {
      utc: now.toISOString(),
      local: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unix_ms: now.getTime(),
    };
  },
  false,
  "datetime",
);
