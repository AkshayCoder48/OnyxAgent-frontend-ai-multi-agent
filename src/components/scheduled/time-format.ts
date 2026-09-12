// ============================================================================
// Time formatting for the Scheduled Tasks UI.
//
// Rules (spec): relative formatting for the past ("5m ago"), and for the NEXT
// run a friendly "Today, 09:00" / "Tomorrow, 09:00" within 2 days — with the
// TIME rendered in the TASK's timezone (Intl with `timeZone`), never the
// browser's, so what the user reads is exactly what the scheduler will do.
// ============================================================================

/** "just now" / "45s ago" / "5m ago" / "3h ago" / "2d ago" / date. */
export function formatRelativeAgo(ts: number | string | null | undefined): string {
  if (ts == null) return "—";
  const then = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  if (diff < 0) {
    // future — delegate to next-run style
    return formatNextRun(then, undefined);
  }
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Wall-clock time (HH:MM) of an instant, in the given timezone. */
function timeInZone(ts: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(tz ? { timeZone: tz } : {}),
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}

/** Which calendar day an instant lands on, in the given timezone. */
function dayInZone(ts: number, tz?: string): {
  y: number;
  m: number;
  d: number;
} {
  const parts = (() => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        ...(tz ? { timeZone: tz } : {}),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(ts));
    } catch {
      return "";
    }
  })();
  const [y, m, d] = parts.split("-").map((v) => parseInt(v, 10));
  return { y: y || 1970, m: m || 1, d: d || 1 };
}

function dayDiff(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): number {
  const toUtc = (x: { y: number; m: number; d: number }) => Date.UTC(x.y, x.m - 1, x.d);
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/**
 * "Today, 09:00" / "Tomorrow, 09:00" within 2 days; "In 2 days, 09:00";
 * weekday within a week; absolute date beyond. Time-of-day is in the TASK's
 * timezone.
 */
export function formatNextRun(ts: number | null, tz?: string): string {
  if (ts == null) return "—";
  if (!Number.isFinite(ts)) return "—";
  const nowDay = dayInZone(Date.now(), tz);
  const runDay = dayInZone(ts, tz);
  const diffDays = dayDiff(runDay, nowDay);
  const time = timeInZone(ts, tz);
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Tomorrow, ${time}`;
  if (diffDays === 2) return `In 2 days, ${time}`;
  if (diffDays > 0 && diffDays <= 7) {
    try {
      const weekday = new Intl.DateTimeFormat(undefined, {
        ...(tz ? { timeZone: tz } : {}),
        weekday: "short",
      }).format(new Date(ts));
      return `${weekday}, ${time}`;
    } catch {
      /* fall through */
    }
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(tz ? { timeZone: tz } : {}),
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/** Absolute timestamp (short) — used for "last run" + run-history rows. */
export function formatAbsolute(
  ts: number | string | null | undefined,
  tz?: string,
): string {
  if (ts == null) return "—";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(tz ? { timeZone: tz } : {}),
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(t));
  } catch {
    return new Date(t).toLocaleString();
  }
}

/** "1m 24s" / "2h 03m" / "48s" — run durations. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${hours}h ${String(min).padStart(2, "0")}m` : `${hours}h`;
}
