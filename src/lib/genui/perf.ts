/**
 * GenUI / scroll performance instrumentation (PRD §16).
 *
 * DEV-ONLY, opt-in via localStorage flag:
 *   localStorage.setItem("onyx-genui-perf", "1")
 *
 * Logs the events the PRD's investigation called for — GenUI parses, GenUI
 * node mounts (remount detection), and chat scroll writes — so regressions
 * of the flicker/scroll-jank fixes are visible in the devtools console.
 * Zero overhead in production (the flag check collapses to a boolean read
 * resolved once at module load).
 */

const isEnabled =
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined" &&
  (() => {
    try {
      return window.localStorage.getItem("onyx-genui-perf") === "1";
    } catch {
      return false;
    }
  })();

/** Dev-only event log: `[GenUI] <event>` / `[Scroll] <event>`. */
export function genuiPerfLog(scope: "GenUI" | "Scroll", event: string, detail?: unknown): void {
  if (!isEnabled) return;
  if (detail === undefined) {
    console.log(`[${scope}] ${event}`);
  } else {
    console.log(`[${scope}] ${event}`, detail);
  }
}
