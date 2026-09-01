"use client";

import type { CSSProperties } from "react";
import styles from "./Orb.module.css";

/**
 * Orb — compact animated activity indicator for agent UIs (AICSS "Orbs"
 * recipe): a 3×3 lattice of dots whose choreography (variant S1–S5) signals
 * what the agent is doing without blocking the thread.
 *
 * Geometry is tuned on a 28px stage; `--orb-k` (size / 28) scales it to the
 * rendered `size`. Each cell's `animation-delay` seeds it partway into its
 * cycle; the `--orb-ax/ay` and `--orb-bx/by` custom properties carry the
 * swirl "gather" and "release" offsets (stage px) the keyframes read.
 */
const STAGE = 28;
/** Default rendered size — 20×20 indicator box. */
const SIZE = 20;

export type LatticeVariant = "S1" | "S2" | "S3" | "S4" | "S5";
export type OrbVariant = LatticeVariant;

export const ORB_TASKS: Record<OrbVariant, string> = {
  S1: "Thinking",
  S2: "Thinking",
  S3: "Thinking",
  S4: "Thinking",
  S5: "Thinking",
};

const N = 3; // lattice is N×N
const PITCH = 6; // centre-to-centre spacing in stage px; the dot size is CSS
const MID = (N - 1) / 2;

/** Clockwise walk of the lattice perimeter — the track `orbit` runs on. */
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
 * into its cycle, which is what turns 8 identical animations into one
 * comet travelling the ring.
 */
function cellDelay(v: LatticeVariant, x: number, y: number): number {
  const dx = x - MID;
  const dy = y - MID;
  switch (v) {
    // Radiates from the centre on a round wavefront. Centre leads a beat
    // early so the next swell doesn't sit behind the outer fade.
    case "S1":
      return Math.hypot(dx, dy) * 700 - (dx === 0 && dy === 0 ? 180 : 0);
    // A broad band crosses the grid on the diagonal. The spread is close to
    // the wave duration, which both widens the band and makes the sweep
    // continuous — the far corner restarts as the near one does.
    case "S2":
      return ((x + y) / (2 * (N - 1))) * 1500;
    // One head with a decaying tail, running the perimeter clockwise.
    case "S3": {
      const i = RING_INDEX.get(x + "," + y);
      if (i === undefined) return 0;
      return -(((RING.length - i) % RING.length) / RING.length) * 1700;
    }
    // A soft column travels left to right.
    case "S4":
      return (x / (N - 1)) * 1100;
    // Like S3 but scrambled order — the pulse jumps pseudo-randomly.
    case "S5": {
      const i = RING_INDEX.get(x + "," + y);
      if (i === undefined) return 0;
      const scrambled = (i * 3) % RING.length;
      return -(scrambled / RING.length) * 1700;
    }
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
  /** Sits out the choreography (interior cells during `orbit`). */
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
        left: x * PITCH,
        top: y * PITCH,
        delay: cellDelay(v, x, y),
        ax,
        ay,
        bx,
        by,
        still: (v === "S3" || v === "S5") && !RING_INDEX.has(x + "," + y),
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
        style={{ width: size, height: size, "--orb-k": size / STAGE } as CSSProperties}
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

/* Usage:
       <Orb variant="S1" />
       <Orb variant="S1" label="…" pill />
 */
