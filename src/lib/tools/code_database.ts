"use client";

import { registerTool } from "./registry";
import {
  CODE_DB_PREFIX,
  codeDbKey,
  codeDbFailureMessage,
  listCodeDbRecords,
  resolveCodeDbClient,
} from "@/lib/code/db-namespace";

/**
 * OnyxCode `manage_database` (OnyxCode PRD §6) — CRUD over the OnyxBase KV
 * records for the current workspace, namespaced under `code:db:*`. The
 * Database tab (/code/database) browses/edits the EXACT same records, so
 * everything the agent stores is immediately visible there (and vice
 * versa). Follows the one-tool + action pattern (like manage_memory).
 */
registerTool(
  "manage_database",
  "Read and write the OnyxCode app database — a document store in the user's OnyxBase cloud (workspace_default). Actions: `list` (all documents), `get` (one document by name), `set` (create/overwrite a document with a JSON value), `delete` (remove a document). Documents are JSON values keyed by name (e.g. app-config, users/42). The Code Mode Database tab shows the same data live.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "set", "delete"],
        description: "The database operation to perform.",
      },
      name: {
        type: "string",
        description: "Document name (key, without the code:db: prefix). Required for get/set/delete.",
      },
      value: {
        type: "string",
        description: "For `set`: the document value — a JSON string (object, array, or scalar) or plain text.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args) => {
    const action = String(args.action ?? "");
    const name = args.name ? String(args.name) : "";
    const value = args.value !== undefined ? String(args.value) : undefined;

    if (action !== "list" && !name.trim()) {
      return { ok: false, error: `name is required for ${action}.` };
    }

    const resolved = await resolveCodeDbClient();
    if ("kind" in resolved) {
      return {
        ok: false,
        error: codeDbFailureMessage(resolved),
      };
    }

    try {
      if (action === "list") {
        const records = await listCodeDbRecords(resolved);
        return {
          kind: "code_database",
          ok: true,
          action: "list",
          prefix: CODE_DB_PREFIX,
          count: records.length,
          documents: records.map((r) => ({
            name: r.name,
            isJson: r.isJson,
            size: r.size,
            preview: r.value.slice(0, 200),
          })),
        };
      }

      if (action === "get") {
        const raw = await resolved.kv.get(codeDbKey(name));
        if (raw === null) {
          return { ok: false, error: `Document "${name}" not found.` };
        }
        let parsed: unknown;
        let isJson = false;
        try {
          parsed = JSON.parse(raw);
          isJson = true;
        } catch {
          /* plain text document */
        }
        return {
          kind: "code_database",
          ok: true,
          action: "get",
          name,
          isJson,
          ...(isJson ? { value: parsed } : { text: raw }),
        };
      }

      if (action === "set") {
        if (value === undefined) {
          return { ok: false, error: "value is required for set (a JSON string or text)." };
        }
        // Normalize: if the value parses as JSON, store it re-serialized
        // (stable formatting); otherwise store the text as-is.
        let stored = value;
        try {
          stored = JSON.stringify(JSON.parse(value));
        } catch {
          /* plain text */
        }
        await resolved.kv.set(codeDbKey(name), stored);
        return { kind: "code_database", ok: true, action: "set", name, saved: true };
      }

      if (action === "delete") {
        await resolved.kv.delete(codeDbKey(name));
        return { kind: "code_database", ok: true, action: "delete", name, deleted: true };
      }

      return { ok: false, error: `Unknown action "${action}". Use list, get, set, or delete.` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  false,
  "code",
);
