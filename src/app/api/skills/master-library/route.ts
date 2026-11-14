// ============================================================================
// GET /api/skills/master-library — the MASTER SKILL LIBRARY zip, served for
// the Trigger.dev worker's background agent runs.
//
// The worker (trigger-worker/) attaches the full 55-skill library to every
// task sandbox so background runs have the app's complete skill surface
// (user directive 2026-11-14). Bundling the ~2 MB zip INTO the worker
// package crashed the trigger.dev build service, so the worker instead
// FETCHES it from here at runtime — which also keeps a single source of
// truth: skills update with the app, no worker re-deploy needed.
//
// The payload is not credential-bearing (it is the same library the app
// attaches to every user sandbox), so the route is unauthenticated; the
// worker resolves it via the per-run appUrl (the dispatching request's
// origin, carried in the run payload) or its deployed APP_URL env.
//
//   GET → 200 application/zip (the library archive)
//         x-onyx-skills-version: <MASTER_SKILLS_VERSION>
//         x-onyx-skills-count: <MASTER_SKILLS_COUNT>
// ============================================================================
import { NextResponse } from "next/server";
import {
  MASTER_SKILLS_COUNT,
  MASTER_SKILLS_VERSION,
} from "@/lib/agent/master-skills";
import { MASTER_SKILLS_ZIP_BASE64 } from "@/lib/agent/master-skills-zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Decoded once per server instance — the zip is ~2 MB.
const g = globalThis as unknown as { __onyxSkillsZipBytes?: Uint8Array };
function zipBytes(): Uint8Array {
  if (!g.__onyxSkillsZipBytes) {
    g.__onyxSkillsZipBytes = new Uint8Array(
      Buffer.from(MASTER_SKILLS_ZIP_BASE64, "base64"),
    );
  }
  return g.__onyxSkillsZipBytes;
}

export async function GET() {
  const bytes = zipBytes();
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(bytes.byteLength),
      "x-onyx-skills-version": MASTER_SKILLS_VERSION,
      "x-onyx-skills-count": String(MASTER_SKILLS_COUNT),
      // The library is version-stamped per release; short edge caching keeps
      // sandbox boots fast while still picking up new versions promptly.
      "cache-control": "public, max-age=300",
    },
  });
}
