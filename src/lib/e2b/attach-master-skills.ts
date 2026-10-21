import type { Sandbox } from "@e2b/code-interpreter";
import { MASTER_SKILLS_VERSION } from "@/lib/agent/master-skills";
import { MASTER_SKILLS_ZIP_BASE64 } from "@/lib/agent/master-skills-zip";

/**
 * Attach the MASTER SKILL LIBRARY to an E2B sandbox (user request
 * 2026-10-19: "merge all into a single folder skill or zip attached every
 * time on sandbox startup").
 *
 * The whole library (55 skills + MASTER-INDEX.md) ships as ONE zip baked
 * into the app (src/lib/agent/master-skills-zip.ts — same bundling
 * guarantee as Onyx.md: Vercel serverless only traces static imports, so a
 * runtime fs read would NOT be included). attachMasterSkills writes the
 * zip into the sandbox, extracts it over /home/user/skills/ (idempotent —
 * `unzip -o` overwrites), and removes the zip payload again.
 *
 * Extraction: `unzip` first (present on the e2b base image), python3's
 * zipfile module as the fallback — one chained shell command, no
 * second round trip.
 *
 * Called from:
 *   - createAndCacheSandbox (every fresh sandbox)
 *   - the cached/reconnect/metadata adoption paths when the sandbox's
 *     skills version predates MASTER_SKILLS_VERSION (version-gated, so a
 *     live sandbox is only re-attached when the library actually changed)
 *   - every sandbox boot ensures the skills directory exists
 *
 * Best-effort by design: a failed attach logs and continues — a sandbox
 * without the library still works, and the next startup retries.
 */

const ZIP_PATH = "/home/user/.onyx/master-skills.zip";
const EXTRACT_CMD = [
  "mkdir -p /home/user/skills",
  `cd /home/user/skills`,
  `(unzip -oq '${ZIP_PATH}' 2>/dev/null || python3 -m zipfile -e '${ZIP_PATH}' .)`,
  `rm -f '${ZIP_PATH}'`,
  `printf '%s' '${MASTER_SKILLS_VERSION}' > /home/user/.onyx/master-skills-version`,
].join(" && ");

let cachedBytes: Uint8Array<ArrayBuffer> | null = null;

/** Decode the base64 payload once (the zip is ~2MB — cache the bytes).
 * Copied into a standalone ArrayBuffer-backed view so it is BlobPart-safe. */
function zipBytes(): Uint8Array<ArrayBuffer> {
  if (!cachedBytes) {
    const buf = Buffer.from(MASTER_SKILLS_ZIP_BASE64, "base64");
    const out = new Uint8Array(buf.byteLength);
    out.set(buf);
    cachedBytes = out;
  }
  return cachedBytes;
}

export interface AttachResult {
  attached: boolean;
  error?: string;
}

export async function attachMasterSkills(sandbox: Sandbox): Promise<AttachResult> {
  try {
    await sandbox.files.write(ZIP_PATH, new Blob([zipBytes()]));
    const result = await sandbox.commands.run(EXTRACT_CMD, {
      timeoutMs: 90_000,
    });
    if (result.exitCode !== 0) {
      const msg = `exit ${result.exitCode}: ${(result.stderr ?? "").slice(0, 200)}`;
      console.warn(`[sandbox] master-skills attach failed — ${msg}`);
      return { attached: false, error: msg };
    }
    return { attached: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sandbox] master-skills attach failed — ${msg}`);
    return { attached: false, error: msg };
  }
}

/**
 * Version-gated attach: re-attach ONLY when the sandbox's stamped version
 * (read from /home/user/.onyx/master-skills-version) differs from the
 * current library. Keeps reconnect paths cheap — one small file read
 * instead of a 2MB write + extract on every adoption.
 */
export async function ensureMasterSkills(
  sandbox: Sandbox,
): Promise<AttachResult> {
  try {
    const stamped = await sandbox.files.read(
      "/home/user/.onyx/master-skills-version",
      { format: "text" },
    );
    if (stamped.trim() === MASTER_SKILLS_VERSION) {
      return { attached: true };
    }
  } catch {
    // No stamp yet (pre-library sandbox or read failed) — attach below.
  }
  return attachMasterSkills(sandbox);
}
