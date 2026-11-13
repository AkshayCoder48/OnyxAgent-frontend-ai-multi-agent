/**
 * OnyxAgent glass theme — a faithful port of the orange-skin CSS variable system
 * from three-ui-clones (1).html. Every tone derives from one accent hex, exactly
 * like `color-mix(in srgb, ...)` does in the clone.
 */

export type RGB = [number, number, number];

const hx = (hex: string): RGB => {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const toHex = (rgb: RGB) =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** CSS color-mix(in srgb, A r%, B) — r% of A + (100−r)% of B */
export function cmix(a: string, r: number, b: string): string {
  const A = hx(a), B = hx(b);
  const fa = r / 100;
  return toHex([A[0] * fa + B[0] * (1 - fa), A[1] * fa + B[1] * (1 - fa), A[2] * fa + B[2] * (1 - fa)]);
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hx(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function mix(a: string, b: string, fracB: number): string {
  // fracB = share of B (used for white tints / black shades)
  const A = hx(a), B = hx(b);
  return toHex([A[0] * (1 - fracB) + B[0] * fracB, A[1] * (1 - fracB) + B[1] * fracB, A[2] * (1 - fracB) + B[2] * fracB]);
}

const W = '#ffffff', K = '#000000';
const W255 = (a: number) => `rgba(255,255,255,${a})`;

export interface Tones {
  acc: string;
  accHi: string;    // 45% toward white  — gradients, micfab
  accXh: string;     // 25% toward white  — icons on glass, highlights
  accPale: string;   // 65% toward white  — orb highlight
  accSoft: string;   // 55% toward white  — code strings
  glow: (a?: number) => string;
  w: (a: number) => string;
  onAcc: (a: number) => string;
  scrHome: [string, ...string[]];   // 0,14,30,48,68,88,100%
  scrTools: [string, ...string[]];  // 0,20,44,68,100%
  scrChat: [string, ...string[]];   // 0,18,40,64,100%
  scrPlain: [string, string, string, string];  // 0,18,46,100%
  bubble: [string, string];    // user bubble 135deg
  bar: [string, string];       // progress/bar chart
  seg: [string, string];       // segmented .on / CTA 135deg
  codeStr: string;     // color-mix(acc 32%, #fff)
  deep: string;        // darkened code bg tint
}

export function tonesFor(accHex: string): Tones {
  const acc = accHex;
  const accHi = cmix(acc, 45, W);
  const accXh = cmix(acc, 25, W);
  const accPale = cmix(acc, 65, W);
  return {
    acc,
    accHi,
    accXh,
    accPale,
    accSoft: cmix(acc, 55, W),
    glow: (a = 0.45) => rgba(acc, a),
    w: W255,
    onAcc: (a: number) => rgba(acc, a),
    scrHome: [acc, cmix(acc, 90, K), cmix(acc, 70, K), cmix(acc, 34, K), cmix(acc, 11, K), cmix(acc, 5, K), cmix(acc, 4, K)],
    scrTools: [cmix(acc, 74, K), cmix(acc, 50, K), cmix(acc, 17, K), cmix(acc, 6, K), cmix(acc, 3, K)],
    scrChat: [cmix(acc, 78, K), cmix(acc, 46, K), cmix(acc, 15, K), cmix(acc, 5, K), cmix(acc, 3, K)],
    scrPlain: [cmix(acc, 24, K), cmix(acc, 9, K), '#0a0301', '#050100'],
    bubble: [accHi, acc],
    bar: [accHi, acc],
    seg: [accHi, acc],
    codeStr: cmix(acc, 32, W),
    deep: cmix(acc, 12, '#0a0401'),
  };
}

/** The clone's skin presets — same five swatches as the HTML gallery header. */
export const PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Orange', hex: '#F07E12' },
  { name: 'Blue', hex: '#4F6DF5' },
  { name: 'Green', hex: '#10B981' },
  { name: 'Red', hex: '#F0524D' },
  { name: 'Violet', hex: '#8B5CF6' },
];

export const DEFAULT_ACCENT = PRESETS[0].hex;

/** hsl → hex for the live custom-skin hue picker */
export function hslToHex(h: number, s = 74, l = 52): string {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
export function hexToHue(hex: string): number {
  const [r, g, b] = hx(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 30; // orange-ish for achromatic
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export const GREEN = '#8FE3AE';       // done / ok
export const GREEN_SOFT = '#9FE8BB';  // diff add
export const WARN = '#FFC46B';        // waiting / warn
export const RED_SOFT = '#FFA9A9';    // diff rem
