/**
 * XDG/platform path resolution for OnyxAgent CLI.
 *
 * Linux: ${XDG_CONFIG_HOME:-~/.config}/onyxagent, ${XDG_STATE_HOME:-~/.local/state}/onyxagent, ${XDG_CACHE_HOME:-~/.cache}/onyxagent
 * macOS: standard Application Support/State locations or documented XDG-compatible paths
 * Windows: %APPDATA%\OnyxAgent and %LOCALAPPDATA%\OnyxAgent
 */

import { homedir, platform } from "os";
import { join } from "path";
import { mkdirSync, existsSync, chmodSync } from "fs";

const PLATFORM = platform();
const HOME = homedir();

function xdgPath(envVar: string, fallback: string, appName: string): string {
  const base = process.env[envVar] || join(HOME, fallback);
  return join(base, appName);
}

/**
 * Get platform-appropriate paths for config, state, cache, and data.
 */
export function getPaths() {
  if (PLATFORM === "win32") {
    const appdata = process.env.APPDATA || join(HOME, "AppData", "Roaming");
    const localappdata = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
    return {
      config: join(appdata, "OnyxAgent"),
      state: join(localappdata, "OnyxAgent"),
      cache: join(localappdata, "OnyxAgent", "Cache"),
      data: join(localappdata, "OnyxAgent", "Data"),
    };
  }

  if (PLATFORM === "darwin") {
    return {
      config: join(HOME, "Library", "Application Support", "OnyxAgent"),
      state: join(HOME, "Library", "Application Support", "OnyxAgent", "State"),
      cache: join(HOME, "Library", "Caches", "OnyxAgent"),
      data: join(HOME, "Library", "Application Support", "OnyxAgent", "Data"),
    };
  }

  // Linux and other Unix-like systems — XDG Base Directory Specification
  return {
    config: xdgPath("XDG_CONFIG_HOME", ".config", "onyxagent"),
    state: xdgPath("XDG_STATE_HOME", ".local/state", "onyxagent"),
    cache: xdgPath("XDG_CACHE_HOME", ".cache", "onyxagent"),
    data: xdgPath("XDG_DATA_HOME", ".local/share", "onyxagent"),
  };
}

/**
 * Ensure all required directories exist with restrictive permissions (0700).
 * Call this early in CLI startup.
 */
export function ensureDirectories(): void {
  const paths = getPaths();
  for (const dir of Object.values(paths)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      // Set restrictive permissions on Unix
      if (PLATFORM !== "win32") {
        try {
          chmodSync(dir, 0o700);
        } catch {
          // Best effort — may fail on some filesystems
        }
      }
    }
  }
}

/**
 * Get the workspace state directory (.onyxagent/) for a given workspace root.
 */
export function getWorkspaceStateDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".onyxagent");
}

/**
 * Check if a directory is an initialized OnyxAgent workspace.
 */
export function isWorkspace(dir: string): boolean {
  return existsSync(getWorkspaceStateDir(dir));
}

export const PATHS = getPaths();
