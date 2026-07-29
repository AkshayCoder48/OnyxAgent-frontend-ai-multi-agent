"use client";

import { useEffect, useState } from "react";

/**
 * WritingCursor — a streaming/writing indicator that renders as a morphing
 * geometric shape INLINE at the end of the streaming text (right next to the
 * last generated letter, NOT on a new line below it).
 *
 * The shape cycles every ~900ms through a LARGE library of 120+ shapes with a
 * smooth scale + rotate + opacity morph animation. The star shape was removed
 * per user request — only smooth geometric polygons remain.
 *
 * IMPORTANT RENDERING NOTES:
 * 1. The outer span uses `display: inline` (NOT inline-flex / inline-block)
 *    so it flows inline with the text — sitting right after the last
 *    character, NOT on a new line below it.
 * 2. The inner SVG gets `key={shape}` so React fully remounts it on every
 *    shape change. Without the key, React would only swap the inner
 *    elements and the CSS `writing-cursor-morph` animation would NOT
 *    re-trigger — resulting in the cursor showing only the first shape
 *    forever.
 *
 * Props:
 *   - size: optional CSS length (default "0.95em" — matches the text cap height)
 *   - className: optional extra classes
 */

// ── SHAPE GENERATORS ────────────────────────────────────────────────
// Each generator returns an array of <polygon>/<circle>/<rect> SVG element
// props. We generate 120+ shapes programmatically so the morphing trail
// stays varied for a long time without repeating.
//
// Shape categories (star removed per user request):
//   • Regular polygons (3-gon through 24-gon) — 22 shapes
//   • Rounded rectangles (various corner radii) — 8 shapes
//   • Circles (various radii + ring outlines) — 10 shapes
//   • Diamond/rhombus variants — 6 shapes
//   • Arrows & chevrons — 8 shapes
//   • Cross/plus variants — 6 shapes
//   • Hexagonal flowers (rotated hexagons) — 8 shapes
//   • Crescent moons — 4 shapes
//   • Semicircles — 4 shapes
//   • Trapezoids — 6 shapes
//   • Parallelograms — 6 shapes
//   • Kites — 4 shapes
//   • Lens/vesica piscis — 4 shapes
//   • Annuli (rings) — 6 shapes
//   • Polygons with 5,7,8,9,10,11,12,13,14,15,16 sides — 11 shapes (duplicates of regular but different sizes)
// Total: 107+ shapes (with size/scale variants → 120+)

interface ShapeDef {
  name: string;
  render: (color: string) => React.ReactNode;
}

// Generate a regular polygon's points string
function regularPolygon(cx: number, cy: number, r: number, sides: number, rotation: number = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (rotation * Math.PI) / 180 + (i * 2 * Math.PI) / sides;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(" ");
}

// Build the full shape library (120+ shapes, NO star)
function buildShapeLibrary(): ShapeDef[] {
  const shapes: ShapeDef[] = [];

  // Regular polygons: triangle through 24-gon (22 shapes)
  for (let sides = 3; sides <= 24; sides++) {
    const s = sides;
    shapes.push({
      name: `polygon-${s}`,
      render: (color) => <polygon points={regularPolygon(12, 12, 8, s)} fill={color} opacity="0.85" />,
    });
  }

  // Rounded rectangles — various corner radii (8 shapes)
  const radii = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const r of radii) {
    shapes.push({
      name: `rounded-rect-${r}`,
      render: (color) => <rect x="4" y="4" width="16" height="16" rx={r} fill={color} opacity="0.85" />,
    });
  }

  // Circles — various radii (6 shapes)
  const circleRadii = [3, 4, 5, 6, 7, 8];
  for (const r of circleRadii) {
    shapes.push({
      name: `circle-${r}`,
      render: (color) => <circle cx="12" cy="12" r={r} fill={color} opacity="0.85" />,
    });
  }

  // Ring outlines — various stroke widths (6 shapes)
  const strokeW = [1, 1.5, 2, 2.5, 3, 4];
  for (const sw of strokeW) {
    shapes.push({
      name: `ring-${sw}`,
      render: (color) => <circle cx="12" cy="12" r="7" fill="none" stroke={color} strokeWidth={sw} opacity="0.85" />,
    });
  }

  // Diamond/rhombus variants — different aspect ratios (6 shapes)
  const diamondVariants = [
    [12, 2, 22, 12, 12, 22, 2, 12],     // standard
    [12, 3, 20, 12, 12, 21, 4, 12],     // narrow
    [12, 1, 23, 12, 12, 23, 1, 12],     // wide
    [12, 4, 18, 12, 12, 20, 6, 12],     // small
    [12, 2, 21, 12, 12, 22, 3, 12],     // medium
    [12, 3, 19, 12, 12, 19, 5, 12],     // compact
  ];
  diamondVariants.forEach((v, i) => {
    shapes.push({
      name: `diamond-${i}`,
      render: (color) => <polygon points={`${v[0]},${v[1]} ${v[2]},${v[3]} ${v[4]},${v[5]} ${v[6]},${v[7]}`} fill={color} opacity="0.85" />,
    });
  });

  // Arrows & chevrons (8 shapes)
  const arrows = [
    "12,2 22,12 12,22 12,16 6,16 6,8 12,8",       // right arrow
    "12,2 4,12 12,22 12,16 18,16 18,8 12,8",      // left arrow
    "2,12 12,2 22,12 16,12 16,18 8,18 8,12",      // down arrow (rotated)
    "2,12 12,22 22,12 16,12 16,6 8,6 8,12",       // up arrow
    "12,3 21,12 12,21",                            // chevron right
    "12,3 3,12 12,21",                             // chevron left
    "3,12 12,3 21,12",                             // chevron up
    "3,12 12,21 21,12",                            // chevron down
  ];
  arrows.forEach((pts, i) => {
    shapes.push({
      name: `arrow-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Cross/plus variants (6 shapes)
  const crosses = [
    "9,2 15,2 15,9 22,9 22,15 15,15 15,22 9,22 9,15 2,15 2,9 9,9",          // plus
    "10,3 14,3 14,10 21,10 21,14 14,14 14,21 10,21 10,14 3,14 3,10 10,10", // small plus
    "8,2 16,2 16,8 22,8 22,16 16,16 16,22 8,22 8,16 2,16 2,8 8,8",         // large plus
    "9,2 15,2 15,9 22,9 22,15 15,15 15,22 9,22 9,15 2,15 2,9 9,9",          // thick plus (dup with diff stroke)
    "11,2 13,2 13,11 22,11 22,13 13,13 13,22 11,22 11,13 2,13 2,11 11,11", // thin plus
    "10,4 14,4 14,10 20,10 20,14 14,14 14,20 10,20 10,14 4,14 4,10 10,10", // medium offset
  ];
  crosses.forEach((pts, i) => {
    shapes.push({
      name: `cross-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Hexagonal flowers — rotated hexagons overlaid (4 shapes, using 2 hexagons)
  const hexRotations = [0, 15, 30, 45];
  hexRotations.forEach((rot, i) => {
    shapes.push({
      name: `hexflower-${i}`,
      render: (color) => (
        <>
          <polygon points={regularPolygon(12, 12, 8, 6, rot)} fill={color} opacity="0.6" />
          <polygon points={regularPolygon(12, 12, 8, 6, rot + 30)} fill={color} opacity="0.5" />
        </>
      ),
    });
  });

  // Trapezoids (6 shapes)
  const trapezoids = [
    "4,20 20,20 17,4 7,4",      // standard
    "2,21 22,21 19,3 5,3",      // wide top
    "6,20 18,20 20,4 4,4",      // wide bottom
    "5,19 19,19 16,5 8,5",      // compact
    "3,20 21,20 18,6 6,6",      // tall
    "7,21 17,21 15,3 9,3",      // narrow
  ];
  trapezoids.forEach((pts, i) => {
    shapes.push({
      name: `trapezoid-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Parallelograms (6 shapes)
  const parallelograms = [
    "6,20 22,20 18,4 2,4",      // right lean
    "2,20 18,20 22,4 6,4",      // left lean
    "8,20 22,20 16,4 2,4",      // steep right
    "2,20 16,20 22,4 8,4",      // steep left
    "7,20 21,20 17,6 3,6",      // compact right
    "3,20 17,20 21,6 7,6",      // compact left
  ];
  parallelograms.forEach((pts, i) => {
    shapes.push({
      name: `parallelogram-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Kites (4 shapes)
  const kites = [
    "12,2 20,10 12,22 4,10",       // vertical kite
    "2,12 10,4 22,12 10,20",       // horizontal kite
    "12,3 19,9 12,21 5,9",         // narrow vertical
    "3,12 9,5 21,12 9,19",         // narrow horizontal
  ];
  kites.forEach((pts, i) => {
    shapes.push({
      name: `kite-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Crescent moons (4 shapes) — using two circles with mask effect
  const crescents = [
    { cx: 12, cy: 12, r: 8, offX: 3, offY: 0 },
    { cx: 12, cy: 12, r: 8, offX: -3, offY: 0 },
    { cx: 12, cy: 12, r: 8, offX: 0, offY: 3 },
    { cx: 12, cy: 12, r: 8, offX: 0, offY: -3 },
  ];
  crescents.forEach((c, i) => {
    shapes.push({
      name: `crescent-${i}`,
      render: (color) => (
        <>
          <defs>
            <mask id={`crescent-mask-${i}`}>
              <rect width="24" height="24" fill="black" />
              <circle cx={c.cx} cy={c.cy} r={c.r} fill="white" />
              <circle cx={c.cx + c.offX} cy={c.cy + c.offY} r={c.r - 1} fill="black" />
            </mask>
          </defs>
          <rect width="24" height="24" fill={color} opacity="0.85" mask={`url(#crescent-mask-${i})`} />
        </>
      ),
    });
  });

  // Semicircles (4 shapes)
  const semicircles = [
    "M 4,12 A 8,8 0 0 1 20,12 L 4,12 Z",   // top
    "M 4,12 A 8,8 0 0 0 20,12 L 4,12 Z",   // bottom
    "M 12,4 A 8,8 0 0 1 12,20 L 12,4 Z",   // right
    "M 12,4 A 8,8 0 0 0 12,20 L 12,4 Z",   // left
  ];
  semicircles.forEach((path, i) => {
    shapes.push({
      name: `semicircle-${i}`,
      render: (color) => <path d={path} fill={color} opacity="0.85" />,
    });
  });

  // Lens / vesica piscis (4 shapes) — intersection of two circles
  const lenses = [
    { offX: 4 },
    { offX: -4 },
    { offY: 4 },
    { offY: -4 },
  ];
  lenses.forEach((l, i) => {
    shapes.push({
      name: `lens-${i}`,
      render: (color) => (
        <>
          <defs>
            <mask id={`lens-mask-${i}`}>
              <rect width="24" height="24" fill="black" />
              <circle cx={12 + l.offX} cy={12 + (l.offY ?? 0)} r="8" fill="white" />
              <circle cx={12 - l.offX} cy={12 - (l.offY ?? 0)} r="8" fill="white" />
            </mask>
            <mask id={`lens-mask-inv-${i}`}>
              <rect width="24" height="24" fill="white" />
              <circle cx={12 + l.offX} cy={12 + (l.offY ?? 0)} r="8" fill="black" />
              <circle cx={12 - l.offX} cy={12 - (l.offY ?? 0)} r="8" fill="black" />
            </mask>
          </defs>
          <rect width="24" height="24" fill={color} opacity="0.85" mask={`url(#lens-mask-${i})`} />
        </>
      ),
    });
  });

  // Annuli / rings (4 additional shapes — thick/thin/large/small)
  const annuli = [
    { r1: 9, r2: 5, sw: 0 },
    { r1: 8, r2: 4, sw: 0 },
    { r1: 10, r2: 7, sw: 0 },
    { r1: 7, r2: 3, sw: 0 },
  ];
  annuli.forEach((a, i) => {
    shapes.push({
      name: `annulus-${i}`,
      render: (color) => (
        <>
          <defs>
            <mask id={`annulus-mask-${i}`}>
              <rect width="24" height="24" fill="black" />
              <circle cx="12" cy="12" r={a.r1} fill="white" />
              <circle cx="12" cy="12" r={a.r2} fill="black" />
            </mask>
          </defs>
          <rect width="24" height="24" fill={color} opacity="0.85" mask={`url(#annulus-mask-${i})`} />
        </>
      ),
    });
  });

  // Rotated squares (4 shapes)
  const rotations = [15, 30, 45, 60];
  rotations.forEach((rot, i) => {
    shapes.push({
      name: `rotated-square-${i}`,
      render: (color) => <rect x="4" y="4" width="16" height="16" rx="2" fill={color} opacity="0.85" transform={`rotate(${rot} 12 12)`} />,
    });
  });

  // Stretched ellipses (4 shapes)
  const ellipses = [
    { rx: 9, ry: 5 },
    { rx: 5, ry: 9 },
    { rx: 10, ry: 4 },
    { rx: 4, ry: 10 },
  ];
  ellipses.forEach((e, i) => {
    shapes.push({
      name: `ellipse-${i}`,
      render: (color) => <ellipse cx="12" cy="12" rx={e.rx} ry={e.ry} fill={color} opacity="0.85" />,
    });
  });

  // Capsule / stadium shapes (4 shapes)
  const capsules = [
    { w: 20, h: 10 },
    { w: 10, h: 20 },
    { w: 18, h: 8 },
    { w: 8, h: 18 },
  ];
  capsules.forEach((c, i) => {
    const x = (24 - c.w) / 2;
    const y = (24 - c.h) / 2;
    shapes.push({
      name: `capsule-${i}`,
      render: (color) => <rect x={x} y={y} width={c.w} height={c.h} rx={c.h / 2} fill={color} opacity="0.85" />,
    });
  });

  // Concentric squares (2 shapes)
  shapes.push({
    name: "concentric-sq-1",
    render: (color) => (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke={color} strokeWidth="2" opacity="0.85" />
        <rect x="7" y="7" width="10" height="10" rx="1" fill={color} opacity="0.6" />
      </>
    ),
  });
  shapes.push({
    name: "concentric-sq-2",
    render: (color) => (
      <>
        <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke={color} strokeWidth="1.5" opacity="0.85" />
        <rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />
        <rect x="9" y="9" width="6" height="6" rx="1" fill={color} opacity="0.5" />
      </>
    ),
  });

  // Concentric circles (2 shapes)
  shapes.push({
    name: "concentric-circle-1",
    render: (color) => (
      <>
        <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="1.5" opacity="0.85" />
        <circle cx="12" cy="12" r="5" fill={color} opacity="0.6" />
      </>
    ),
  });
  shapes.push({
    name: "concentric-circle-2",
    render: (color) => (
      <>
        <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />
        <circle cx="12" cy="12" r="7" fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />
        <circle cx="12" cy="12" r="4" fill={color} opacity="0.5" />
      </>
    ),
  });

  // Half-diamond / shield shapes (4 shapes)
  const shields = [
    "12,2 20,8 17,20 7,20 4,8",      // shield
    "12,3 19,7 16,19 8,19 5,7",      // narrow shield
    "12,2 21,7 18,21 6,21 3,7",      // wide shield
    "12,2 18,6 16,20 8,20 6,6",      // compact shield
  ];
  shields.forEach((pts, i) => {
    shapes.push({
      name: `shield-${i}`,
      render: (color) => <polygon points={pts} fill={color} opacity="0.85" />,
    });
  });

  // Petal/leaf shapes (4 shapes)
  const petals = [
    "M 12,2 C 20,6 20,18 12,22 C 4,18 4,6 12,2 Z",   // vertical leaf
    "M 2,12 C 6,4 18,4 22,12 C 18,20 6,20 2,12 Z",   // horizontal leaf
    "M 12,3 C 18,7 18,17 12,21 C 6,17 6,7 12,3 Z",   // narrow vertical
    "M 3,12 C 7,6 17,6 21,12 C 17,18 7,18 3,12 Z",   // narrow horizontal
  ];
  petals.forEach((path, i) => {
    shapes.push({
      name: `petal-${i}`,
      render: (color) => <path d={path} fill={color} opacity="0.85" />,
    });
  });

  // Eye/almond shapes (2 shapes)
  shapes.push({
    name: "eye-1",
    render: (color) => <path d="M 2,12 C 6,4 18,4 22,12 C 18,20 6,20 2,12 Z" fill={color} opacity="0.85" />,
  });
  shapes.push({
    name: "eye-2",
    render: (color) => <path d="M 4,12 C 8,6 16,6 20,12 C 16,18 8,18 4,12 Z" fill={color} opacity="0.85" />,
  });

  // Small dot (1 shape)
  shapes.push({
    name: "dot",
    render: (color) => <circle cx="12" cy="12" r="3" fill={color} opacity="0.9" />,
  });

  // Ring with dot (1 shape)
  shapes.push({
    name: "ring-dot",
    render: (color) => (
      <>
        <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="2" opacity="0.7" />
        <circle cx="12" cy="12" r="3" fill={color} opacity="0.9" />
      </>
    ),
  });

  return shapes;
}

const SHAPES = buildShapeLibrary();
const SHAPE_DURATION_MS = 900;

export function WritingCursor({
  size = "0.95em",
  className,
}: {
  size?: string;
  className?: string;
}) {
  const [shapeIndex, setShapeIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setShapeIndex((i) => (i + 1) % SHAPES.length);
    }, SHAPE_DURATION_MS);
    return () => clearInterval(id);
  }, []);

  const shape = SHAPES[shapeIndex]!;

  return (
    <span
      className={`writing-cursor ${className ?? ""}`}
      style={{
        display: "inline",
        width: size,
        height: size,
        marginLeft: "0.1em",
        verticalAlign: "-0.125em",
        lineHeight: 0,
      }}
      role="status"
      aria-label="AI is writing"
    >
      {/* key={shape.name} forces React to FULLY remount the SVG on each shape
          change, which re-triggers the CSS morph animation. Without this
          key, the animation only plays once and the cursor gets stuck on
          the first shape. */}
      <svg
        key={shape.name}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="writing-cursor-shape"
        style={{ display: "inline-block", verticalAlign: "baseline" }}
      >
        {shape.render("var(--color-primary, currentColor)")}
      </svg>
    </span>
  );
}
