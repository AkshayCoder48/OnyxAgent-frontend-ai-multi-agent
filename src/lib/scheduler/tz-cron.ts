/**
 * Schedule math — next-occurrence computation for every schedule type, in
 * the task's IANA timezone (never a UTC offset: offsets break DST).
 *
 * Pure TypeScript, isomorphic (server scheduler + UI preview both import it).
 * Uses Intl.DateTimeFormat wall-clock decomposition — full-ICU Node and every
 * modern browser support it.
 *
 * Schedule types:
 *   once     expression = ISO timestamp
 *   interval expression = seconds (>= 60)
 *   daily    expression = "HH:MM"
 *   weekly   expression = "0,1,2" weekday numbers (0=Sun); time = "HH:MM"
 *   monthly  expression = "15" day-of-month;    time = "HH:MM"
 *   cron     expression = 5-field cron (minute hour dom month dow)
 */

import type { ScheduledTask, TaskSchedule, TaskScheduleMeta } from "./types";

// ---------------------------------------------------------------------------
// Timezone helpers (Intl-based)
// ---------------------------------------------------------------------------

interface WallTime {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: number; // 0=Sunday
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Decompose a UTC instant into the wall-clock time of `tz`. */
export function wallTime(dateMs: number, tz: string): WallTime {
  const parts = fmtFor(tz).formatToParts(new Date(dateMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const h = parseInt(get("hour"), 10) % 24; // "24" normalization for midnight
  return {
    y: parseInt(get("year"), 10),
    mo: parseInt(get("month"), 10),
    d: parseInt(get("day"), 10),
    h,
    mi: parseInt(get("minute"), 10),
    s: parseInt(get("second"), 10),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** The timezone offset (ms east of UTC) in effect at a UTC instant. */
function tzOffsetMs(dateMs: number, tz: string): number {
  const w = wallTime(dateMs, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(dateMs / 1000) * 1000 - (dateMs % 1000);
}

/** Convert a WALL time in `tz` to its UTC instant. Returns null when the wall
 * time falls into a DST hole (never valid) — the caller steps to the next
 * candidate instead of guessing. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  // Two refinement passes handle DST boundaries (offset can differ between
  // the guess instant and the final instant).
  let utc = guess;
  for (let pass = 0; pass < 2; pass++) {
    const off = tzOffsetMs(utc, tz);
    utc = guess - off;
  }
  const w = wallTime(utc, tz);
  if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi) return utc;
  // One more attempt with the fresh offset (DST edge moves as we cross).
  const off2 = tzOffsetMs(utc, tz);
  utc = guess - off2;
  const w2 = wallTime(utc, tz);
  if (w2.y === y && w2.mo === mo && w2.d === d && w2.h === h && w2.mi === mi) return utc;
  return null; // DST hole — invalid wall time
}

// ---------------------------------------------------------------------------
// Cron parsing (5 fields: lists, ranges, steps, 3-letter names)
// ---------------------------------------------------------------------------

export interface CronFields {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Map 3-letter names (sun-sat, jan-dec) to numbers; digits pass through. */
function mapNames(field: string, names: Record<string, number> | undefined): string {
  if (!names) return field;
  const lower = field.toLowerCase();
  return lower.replace(/[a-z]{3}/g, (m) => {
    const v = names[m];
    return v === undefined ? m : String(v);
  });
}

function parseField(rawField: string, min: number, max: number, label: string, names?: Record<string, number>): number[] {
  const mapped = mapNames(rawField.trim().toLowerCase(), names);
  const out = new Set<number>();
  for (const part of mapped.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    let range: [number, number];
    let step = 1;
    if (stepMatch) {
      step = parseInt(stepMatch[2] ?? "1", 10);
      if (step <= 0) throw new Error(`Invalid step in cron ${label} field: "${rawField}"`);
      const base = stepMatch[1] ?? "*";
      range = base === "*" ? [min, max] : base.includes("-") ? (base.split("-").map(Number) as [number, number]) : [parseInt(base, 10), parseInt(base, 10)];
    } else if (part === "*") {
      range = [min, max];
    } else if (part.includes("-")) {
      range = part.split("-").map(Number) as [number, number];
    } else if (/^\d+$/.test(part)) {
      range = [parseInt(part, 10), parseInt(part, 10)];
    } else {
      throw new Error(`Invalid cron ${label} field: "${rawField}"`);
    }
    const lo = range[0] ?? min;
    const hi = range[1] ?? max;
    const start = Math.max(lo, min);
    const end = Math.min(hi, max);
    if (start > end) continue; // e.g. "sun-fri" clipped — empty range
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`Empty cron ${label} field: "${rawField}"`);
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const fields = expr.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week");
  }
  const dowField = fields[4] ?? "*";
  const dowsRaw = parseField(dowField.replace(/\b7\b/g, "0"), 0, 6, "day-of-week", DOW_NAMES);
  return {
    minutes: parseField(fields[0] ?? "*", 0, 59, "minute"),
    hours: parseField(fields[1] ?? "*", 0, 23, "hour"),
    doms: parseField(fields[2] ?? "*", 1, 31, "day-of-month"),
    months: parseField(fields[3] ?? "*", 1, 12, "month", MONTH_NAMES),
    dows: dowsRaw,
    domRestricted: (fields[2] ?? "*") !== "*" && !/^\*\/\d+$/.test(fields[2] ?? "*"),
    dowRestricted: dowField !== "*" && !/^\*\/\d+$/.test(dowField),
  };
}

// ---------------------------------------------------------------------------
// Next-occurrence computation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Search cap: a schedule that never matches within ~13 months is broken. */
const MAX_SEARCH_DAYS = 400;

function parseHHMM(v: string | undefined, fallback = "09:00"): { h: number; mi: number } {
  const m = (v ?? fallback).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 9, mi: 0 };
  return { h: Math.min(23, parseInt(m[1] ?? "9", 10)), mi: Math.min(59, parseInt(m[2] ?? "0", 10)) };
}

function dayMatchesCron(w: WallTime, c: CronFields): boolean {
  if (!c.months.includes(w.mo)) return false;
  const domOk = c.doms.includes(w.d);
  const dowOk = c.dows.includes(w.weekday);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk; // Vixie cron semantics
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/**
 * Compute the next occurrence strictly after `fromMs` (epoch ms), in the
 * schedule's timezone. Returns the occurrence timestamp (epoch ms) or null
 * when the schedule can never fire again (past one-time, expired, or a
 * broken expression — the caller marks the task completed/failed).
 */
export function computeNextRun(
  schedule: { type: string; expression?: string; time?: string; timezone: string; startAt?: string; endAt?: string },
  meta: TaskScheduleMeta,
  fromMs: number,
): number | null {
  const tz = schedule.timezone || "UTC";
  const now = fromMs;
  const endMs = schedule.endAt ? Date.parse(schedule.endAt) : null;

  const finishIfExpired = (ts: number | null): number | null => {
    if (ts == null) return null;
    if (endMs != null && Number.isFinite(endMs) && ts > endMs) return null;
    return ts;
  };

  try {
    switch (schedule.type) {
      case "once": {
        const ts = Date.parse(schedule.expression || schedule.startAt || "");
        if (!Number.isFinite(ts)) return null;
        // A one-time schedule in the past is DONE, not overdue — catch-up
        // only fires it once within a grace window (see engine).
        return ts > now ? ts : null;
      }

      case "interval": {
        const sec = Math.max(60, parseInt(String(meta.intervalSec ?? schedule.expression ?? "0"), 10) || 0);
        if (!sec) return null;
        const startMs = schedule.startAt ? Date.parse(schedule.startAt) : null;
        const anchor = Number.isFinite(startMs as number) && (startMs as number) > now ? (startMs as number) : now;
        return finishIfExpired(anchor + sec * 1000);
      }

      case "daily": {
        const t = parseHHMM(schedule.expression || schedule.time || meta.time);
        return finishIfExpired(nextWall(t.h, t.mi, tz, now, () => true));
      }

      case "weekly": {
        const days = meta.weekdays ?? parseWeekdays(schedule.expression);
        const t = parseHHMM(schedule.time ?? meta.time);
        return finishIfExpired(nextWall(t.h, t.mi, tz, now, (w) => days.includes(w.weekday)));
      }

      case "monthly": {
        const dom = meta.dayOfMonth ?? (parseInt(schedule.expression || "1", 10) || 1);
        const t = parseHHMM(schedule.time ?? meta.time);
        return finishIfExpired(nextWall(t.h, t.mi, tz, now, (w) => w.d === dom));
      }

      case "cron": {
        const c = parseCron(schedule.expression || "");
        // Day-level scan, then time-of-day within the matching day.
        const start = wallTime(now, tz);
        for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
          const candidate = candidateWallDay(start, dayOffset, now, tz);
          if (!candidate) continue;
          if (!dayMatchesCron(candidate, c)) continue;
          for (const h of c.hours) {
            for (const mi of c.minutes) {
              const utc = wallToUtc(candidate.y, candidate.mo, candidate.d, h, mi, tz);
              if (utc != null && utc > now) return finishIfExpired(utc);
            }
          }
        }
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Weekday list for the weekly case — from meta or the expression string. */
function parseWeekdays(expr: string | undefined): number[] {
  const raw = (expr ?? "1")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
  return raw.length ? [...new Set(raw)].sort() : [1];
}

/** The wall date `dayOffset` days after the wall date of `nowMs`. */
function candidateWallDay(wToday: WallTime, dayOffset: number, nowMs: number, tz: string): WallTime | null {
  if (dayOffset === 0) return wToday;
  // Anchor on UTC noon of (dayStart + offset) — noon is never near a DST
  // boundary shift of ±1h, so the wall date lands on the right calendar day.
  const anchor = nowMs - ((wToday.h * 60 + wToday.mi) * 60 + wToday.s) * 1000 + dayOffset * DAY_MS;
  return wallTime(anchor + 12 * 3600_000, tz);
}

/** Generic daily-anchored wall-clock search with a per-day predicate. */
function nextWall(
  h: number,
  mi: number,
  tz: string,
  nowMs: number,
  dayPred: (w: WallTime) => boolean,
): number | null {
  const start = wallTime(nowMs, tz);
  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
    const w = dayOffset === 0 ? start : candidateWallDay(start, dayOffset, nowMs, tz);
    if (!w || !dayPred(w)) continue;
    // Today only counts while HH:MM is still ahead of the current wall time.
    if (dayOffset === 0 && (w.h > h || (w.h === h && w.mi >= mi))) continue;
    const utc = wallToUtc(w.y, w.mo, w.d, h, mi, tz);
    if (utc != null && utc > nowMs) return utc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Human descriptions (UI cards + tool result summaries)
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeSchedule(task: Pick<ScheduledTask, "scheduleType" | "scheduleExpression" | "scheduleMeta">): string {
  const meta = task.scheduleMeta ?? {};
  switch (task.scheduleType) {
    case "once": {
      const ts = Date.parse(task.scheduleExpression || "");
      if (!Number.isFinite(ts)) return "Once (invalid date)";
      return `Once · ${new Date(ts).toLocaleString()}`;
    }
    case "interval": {
      const sec = Math.max(60, parseInt(String(meta.intervalSec ?? task.scheduleExpression ?? "0"), 10) || 0);
      if (sec % 86400 === 0) return `Every ${sec / 86400} day${sec / 86400 > 1 ? "s" : ""}`;
      if (sec % 3600 === 0) return `Every ${sec / 3600} hour${sec / 3600 > 1 ? "s" : ""}`;
      return `Every ${Math.round(sec / 60)} minutes`;
    }
    case "daily":
      return `Every day · ${(meta.time ?? task.scheduleExpression ?? "09:00").trim()}`;
    case "weekly": {
      const days = (meta.weekdays ?? parseWeekdays(task.scheduleExpression)).map((d) => DAY_NAMES[d]).filter(Boolean);
      return `Every ${days.length ? days.join(", ") : "Monday"} · ${(meta.time ?? "09:00").trim()}`;
    }
    case "monthly":
      return `Monthly on day ${meta.dayOfMonth ?? task.scheduleExpression ?? 1} · ${(meta.time ?? "09:00").trim()}`;
    case "cron":
      return `Cron · ${task.scheduleExpression}`;
    default:
      return task.scheduleExpression || "Unknown schedule";
  }
}

/** Parse a TaskSchedule from API/tool payloads → normalized (type, expr, meta). */
export function normalizeSchedule(s: TaskSchedule): { type: string; expression: string; meta: TaskScheduleMeta } {
  const type = s.type;
  let expression = (s.expression ?? "").trim();
  let meta: TaskScheduleMeta = {};
  switch (type) {
    case "once":
      if (!expression) expression = s.startAt ?? "";
      break;
    case "daily":
      expression = (expression || s.time || "09:00").trim();
      meta = { time: expression };
      break;
    case "weekly":
      expression = expression || "1";
      meta = { weekdays: parseWeekdays(expression), time: (s.time ?? "09:00").trim() };
      break;
    case "monthly":
      expression = expression || "1";
      meta = {
        dayOfMonth: Math.min(31, Math.max(1, parseInt(expression, 10) || 1)),
        time: (s.time ?? "09:00").trim(),
      };
      break;
    case "interval": {
      const sec = Math.max(60, parseInt(expression || "3600", 10) || 3600);
      expression = String(sec);
      meta = { intervalSec: sec };
      break;
    }
    case "cron":
      parseCron(expression); // throws on invalid — caller surfaces the error
      break;
  }
  return { type, expression, meta };
}
