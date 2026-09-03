"use client";

import type { CSSProperties } from "react";
import styles from "./Orb.module.css";

/**
 * Orb — compact animated activity indicator for agent UIs (AICSS "Orbs"
 * recipe): a 3×3 lattice of dots whose choreography signals what the agent
 * is doing without blocking the thread.
 *
 * Five variant families × five variants each = 25 orbs:
 *
 *   S (swell)  — waves radiating across the lattice (S1–S5)
 *   G (gather) — reversed wavefronts, outside-in and edge sweeps (G1–G5)
 *   C (comet)  — a head with a tail running the perimeter, various speeds
 *                and directions, including a two-headed comet (C1–C5)
 *   B (blink)  — scattered, checkerboard, and alternating blinks (B1–B5)
 *   M (march)  — scan-order marches: rows, columns, perimeter patrol,
 *                spiral (M1–M5)
 *
 * Geometry is tuned on a 28px stage; `--orb-k` (size / 28) scales it to the
 * rendered `size`, and `--orb-d` overrides the cell cycle duration for the
 * fast/slow variants. Each cell's `animation-delay` seeds it partway into
 * its cycle; the `--orb-ax/ay` and `--orb-bx/by` custom properties carry
 * the swirl "gather" and "release" offsets (stage px) the keyframes read.
 */
const STAGE = 28;
/** Default rendered size — 20×20 indicator box. */
const SIZE = 20;

export type LatticeVariant =
  | "S1" | "S2" | "S3" | "S4" | "S5"
  | "G1" | "G2" | "G3" | "G4" | "G5"
  | "C1" | "C2" | "C3" | "C4" | "C5"
  | "B1" | "B2" | "B3" | "B4" | "B5"
  | "M1" | "M2" | "M3" | "M4" | "M5";
export type OrbVariant = LatticeVariant;

/** Default status text per family (used when `pill` is set without a label). */
export const ORB_TASKS: Record<OrbVariant, string> = {
  S1: "Thinking", S2: "Thinking", S3: "Thinking", S4: "Thinking", S5: "Thinking",
  G1: "Gathering", G2: "Gathering", G3: "Gathering", G4: "Gathering", G5: "Gathering",
  C1: "Chasing", C2: "Chasing", C3: "Chasing", C4: "Chasing", C5: "Chasing",
  B1: "Pulsing", B2: "Pulsing", B3: "Pulsing", B4: "Pulsing", B5: "Pulsing",
  M1: "Marching", M2: "Marching", M3: "Marching", M4: "Marching", M5: "Marching",
};

/** Cell cycle duration per variant (ms). Unlisted variants use 2000ms. */
const DURATIONS: Partial<Record<OrbVariant, number>> = {
  C1: 1400,
  C2: 1200,
  C5: 1000,
  C3: 2600,
  M3: 1600,
  B2: 2200,
};

/** Variants whose interior cells sit out (perimeter-only choreography). */
const RING_ONLY: ReadonlySet<string> = new Set(["S3", "S5", "C1", "C2", "C3", "C4", "C5", "M3"]);

const N = 3; // lattice is N×N
const PITCH = 6; // centre-to-centre spacing in stage px; the dot size is CSS
const CELL = 4; // dot edge in stage px — kept in sync with .cell in Orb.module.css
const MID = (N - 1) / 2;

/** The N×N grid spans (N-1)·PITCH + CELL px — 16 of the 28px stage. OFFSET
 * recenters the grid inside the stage so the dot CLUSTER's visual centre
 * lands on the glyph BOX's centre. The old top-left-corner placement left
 * the cluster's centre 6px up-left of the box centre, so any text sharing
 * an `items-center` row with the orb (the "Thinking" line) centred on the
 * BOX and ended up ~6px below the dots. Because .lattice scales the whole
 * coordinate space (--orb-k, origin 0 0), the offset scales with the size —
 * the cluster stays centred at every rendered size. */
const GRID_SPAN = (N - 1) * PITCH + CELL; // 16
const OFFSET = (STAGE - GRID_SPAN) / 2; // 6 — recentring margin

/** Clockwise walk of the lattice perimeter — the track comets run on. */
const RING: [number, number][] = (() => {
  const ring: [number, number][] = [];
  for (let x = 0; x < N; x++) ring.push([x, 0]);
  for (let y = 1; y < N; y++) ring.push([N - 1, y]);
  for (let x = N - 2; x >= 0; x--) ring.push([x, N - 1]);
  for (let y = N - 2; y >= 1; y--) ring.push([0, y]);
  return ring;
})();

const RING_INDEX = new Map(RING.map(([x, y], i) => [x + "," + y, i]));

/**
 * Per-cell `animation-delay` in ms. Negative values seed a cell partway
 * into its cycle, which is what turns 9 identical animations into one
 * travelling wave, comet, or blink pattern.
 */
function cellDelay(v: LatticeVariant, x: number, y: number): number {
  const dx = x - MID;
  const dy = y - MID;
  const i = RING_INDEX.get(x + "," + y) ?? 0;
  switch (v) {
    // ── S family: swells ────────────────────────────────────────────────
    // Radiates from the centre on a round wavefront. Centre leads a beat
    // early so the next swell doesn't sit behind the outer fade.
    case "S1":
      return Math.hypot(dx, dy) * 700 - (dx === 0 && dy === 0 ? 180 : 0);
    // A broad band crosses the grid on the diagonal.
    case "S2":
      return ((x + y) / (2 * (N - 1))) * 1500;
    // One head with a decaying tail, running the perimeter clockwise.
    case "S3":
      return -(((RING.length - i) % RING.length) / RING.length) * 1700;
    // A soft column travels left to right.
    case "S4":
      return (x / (N - 1)) * 1100;
    // Like S3 but scrambled order — the pulse jumps pseudo-randomly.
    case "S5":
      return -(((i * 3) % RING.length) / RING.length) * 1700;

    // ── G family: gathers (reversed wavefronts) ─────────────────────────
    // The wave collapses inward — outer cells lead, the centre lands last.
    case "G1":
      return (2 - Math.hypot(dx, dy)) * 650;
    // The diagonal band runs the other way (SE → NW).
    case "G2":
      return ((2 * (N - 1) - (x + y)) / (2 * (N - 1))) * 1500;
    // Column sweeps right to left.
    case "G3":
      return ((N - 1 - x) / (N - 1)) * 1100;
    // Rows march bottom to top.
    case "G4":
      return ((N - 1 - y) / (N - 1)) * 1100;
    // Corners fire first, then the wave pulls into the cross.
    case "G5":
      return (Math.abs(dx) + Math.abs(dy)) * 380;

    // ── C family: comets ────────────────────────────────────────────────
    // Counterclockwise comet (mirror of S3).
    case "C1":
      return -((i % RING.length) / RING.length) * 1400;
    // Fast clockwise comet (short cycle).
    case "C2":
      return -(((RING.length - i) % RING.length) / RING.length) * 1200;
    // Slow, deliberate comet with a long tail.
    case "C3":
      return -(((RING.length - i) % RING.length) / RING.length) * 2600;
    // Two heads on opposite sides chase each other around the ring.
    case "C4":
      return -(((i % (RING.length / 2)) / (RING.length / 2)) * 1700);
    // Fast counterclockwise — the quickest patrol.
    case "C5":
      return -((i % RING.length) / RING.length) * 1000;

    // ── B family: blinks ────────────────────────────────────────────────
    // Checkerboard — two interleaved phases.
    case "B1":
      return ((x + y) % 2) * 900;
    // Pseudo-random scatter.
    case "B2":
      return ((x * 7 + y * 13) % 5) * 360;
    // Columns alternate, each column slightly staggered.
    case "B3":
      return (x % 2) * 800 + y * 160;
    // Rows alternate, each row slightly staggered.
    case "B4":
      return (y % 2) * 800 + x * 160;
    // The cross lights first, the corners answer late.
    case "B5":
      return x === MID || y === MID ? Math.abs(dx + dy) * 120 : 850 + Math.abs(dx * dy) * 40;

    // ── M family: marches ───────────────────────────────────────────────
    // Row scan — the wave reads the grid like text, left-to-right, top-down.
    case "M1":
      return (y * N + x) * 260;
    // Column scan — top-to-bottom, then left-to-right.
    case "M2":
      return (x * N + y) * 260;
    // Perimeter patrol — evenly phased cells walk the ring continuously.
    case "M3":
      return -(i / RING.length) * 1600;
    // Spiral — each ring of the square leads the one outside it.
    case "M4": {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      return ring * 420 + ((x + y) % 2) * 210;
    }
    // Cross sweep — the plus-shape lights outward from the centre.
    case "M5":
      return (dx === 0 ? Math.abs(dy) : Math.abs(dx) + 0.5) * 380;
  }
}

/**
 * `settle` gathers each cell from a position rotated one way around the
 * centre and releases it to the mirror rotation, so the cycle keeps swirling
 * the same way instead of rewinding to where it came from.
 */
const SWIRL = 1.05; // radians of rotation at each end, ~60°
const SPREAD = 1.6; // outward push, on top of the rotation

/** Offset from a cell's own grid slot to its swirled position, in stage px. */
function swirl(x: number, y: number, angle: number): [number, number] {
  const dx = x - MID;
  const dy = y - MID;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    ((dx * cos - dy * sin) * SPREAD - dx) * PITCH,
    ((dx * sin + dy * cos) * SPREAD - dy) * PITCH,
  ];
}

interface Cell {
  key: string;
  left: number;
  top: number;
  delay: number;
  /** Where `settle` gathers this cell from, and releases it to. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Sits out the choreography (interior cells during perimeter runs). */
  still: boolean;
  /** Centre cell — the static frame under reduced motion. */
  mid: boolean;
}

/** The 9 lattice cells, with position, phase and swirl vectors. */
function latticeCells(v: LatticeVariant): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [ax, ay] = swirl(x, y, -SWIRL);
      const [bx, by] = swirl(x, y, SWIRL);
      cells.push({
        key: x + "," + y,
        left: OFFSET + x * PITCH,
        top: OFFSET + y * PITCH,
        delay: cellDelay(v, x, y),
        ax,
        ay,
        bx,
        by,
        still: RING_ONLY.has(v) && !RING_INDEX.has(x + "," + y),
        mid: x === MID && y === MID,
      });
    }
  }
  return cells;
}

export interface OrbProps {
  variant?: OrbVariant;
  /** Rendered edge length in px. The 28px geometry scales to fit. */
  size?: number;
  /** Accessible label, and the status text when `pill` is set. */
  label?: string;
  /** Wraps the orb and its label in a status pill. */
  pill?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Orb({
  variant = "S1",
  size = SIZE,
  label,
  pill,
  className,
  style,
}: OrbProps) {
  const text = label ?? ORB_TASKS[variant] + "…";
  const duration = DURATIONS[variant];
  return (
    <span
      className={styles.root + (className ? " " + className : "")}
      data-pill={pill ? "" : undefined}
      style={style}
    >
      <span
        className={styles.glyph}
        // In pill form the visible label already carries the meaning, so
        // the glyph steps out of the accessibility tree.
        role={pill ? undefined : "img"}
        aria-label={pill ? undefined : text}
        aria-hidden={pill ? true : undefined}
        style={
          {
            width: size,
            height: size,
            "--orb-k": size / STAGE,
            ...(duration !== undefined ? { "--orb-d": `${duration}ms` } : {}),
          } as CSSProperties
        }
      >
        <span className={styles.lattice} data-variant={variant}>
          {latticeCells(variant).map((c) => (
            <span
              key={c.key}
              className={styles.cell}
              data-still={c.still ? "" : undefined}
              data-mid={c.mid ? "" : undefined}
              style={
                {
                  left: c.left,
                  top: c.top,
                  animationDelay: c.delay + "ms",
                  "--orb-ax": c.ax + "px",
                  "--orb-ay": c.ay + "px",
                  "--orb-bx": c.bx + "px",
                  "--orb-by": c.by + "px",
                } as CSSProperties
              }
            />
          ))}
        </span>
      </span>
      {pill && <span className={styles.pillLabel}>{text}</span>}
    </span>
  );
}

/**
 * OrbCursor — the orb as a streaming cursor. A tiny lattice orb that sits
 * INLINE right after the latest generated letter and acts as the caret
 * while the assistant streams. Decorative (aria-hidden); the reading order
 * of the text does not include it.
 */
export function OrbCursor({
  variant = "C2",
  size = 14,
  className,
  style,
}: {
  variant?: OrbVariant;
  /** Edge length in px. ~1em of body text ≈ 14–16px. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={styles.cursorInline + (className ? " " + className : "")}
      aria-hidden="true"
      style={style}
    >
      <Orb variant={variant} size={size} />
    </span>
  );
}

/* Usage:
       <Orb variant="S1" />
       <Orb variant="G3" label="…" pill />
       <OrbCursor variant="C2" />   — inline, next to the last streamed letter
 */
