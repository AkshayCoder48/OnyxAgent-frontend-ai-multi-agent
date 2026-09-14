/**
 * OnyxAI bridge — SERVER-side helpers shared by the /api/onyxai/bridge/* routes.
 *
 * Auth model:
 *   - submit + stream (called from INSIDE the E2B sandbox): the per-execution
 *     bridge TOKEN. The engine wrote `onyxai:bridge:auth:<token>` at launch;
 *     the record carries an expiry. The sandbox never sees the OnyxBase key.
 *   - req (called from the browser): the `X-OnyxBase-Key` header — the same
 *     vault-key pattern every /api/scheduler route uses — or the server env
 *     key when the browser didn't send one.
 */

import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  bridgeAuthKey,
  type BridgeAuthRecord,
  type BridgeRequestRecord,
} from "@/lib/onyxai/bridge-protocol";

/** Resolve the KV the bridge routes operate on. The env key is required
 *  (the sandbox has no vault); the browser's X-OnyxBase-Key also works for
 *  /req. The base URL honors ONYXBASE_BASE_URL (self-hosted instances —
 *  mirrors the app's custom-instance setting). */
export function bridgeKV(headerKey: string | null): SchedulerKV | null {
  const key = resolveSchedulerKey(headerKey);
  if (!key) return null;
  const baseUrl = (process.env.ONYXBASE_BASE_URL ?? "").trim() || null;
  return new SchedulerKV(key, baseUrl);
}

export interface BridgeTokenCheck {
  ok: boolean;
  status: number;
  auth?: BridgeAuthRecord;
  error?: string;
}

/** Validate a bridge token → its auth record. 401 shapes are deliberately
 *  terse (the caller is our own sandbox, not a user). */
export async function checkBridgeToken(kv: SchedulerKV, token: string): Promise<BridgeTokenCheck> {
  const t = (token ?? "").trim();
  if (!t || t.length > 100) return { ok: false, status: 401, error: "bad token" };
  let raw: string | null = null;
  try {
    raw = await kv.get(bridgeAuthKey(t));
  } catch {
    return { ok: false, status: 500, error: "kv read failed" };
  }
  if (!raw) return { ok: false, status: 401, error: "unknown token" };
  let auth: BridgeAuthRecord;
  try {
    auth = JSON.parse(raw) as BridgeAuthRecord;
  } catch {
    return { ok: false, status: 401, error: "corrupt auth record" };
  }
  if (typeof auth.expiresAt === "number" && Date.now() > auth.expiresAt) {
    return { ok: false, status: 401, error: "token expired" };
  }
  return { ok: true, status: 200, auth };
}

/** Read + parse a queue record (null when absent/corrupt). */
export async function readBridgeRequest(
  kv: SchedulerKV,
  reqId: string,
): Promise<BridgeRequestRecord | null> {
  const id = (reqId ?? "").trim();
  if (!id || id.length > 120) return null;
  let raw: string | null = null;
  try {
    raw = await kv.get("onyxai:bridge:req:" + id);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BridgeRequestRecord;
  } catch {
    return null;
  }
}

/** Resolve the app's public origin — the sandbox calls back into THIS app.
 *  Explicit (request) origin wins; then Vercel envs; then localhost dev. */
export function resolveAppOrigin(explicit?: string | null): string {
  const trimmed = (explicit ?? "").trim();
  if (trimmed) return trimmed.replace(/\/+$/, "");
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (prod) return "https://" + prod.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const dep = (process.env.VERCEL_URL ?? "").trim();
  if (dep) return "https://" + dep.replace(/\/+$/, "");
  const app = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (app) return app.replace(/\/+$/, "");
  return "http://localhost:3000";
}
