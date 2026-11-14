/**
 * Streaming motion — the user-selectable word-streaming animation
 * (uploaded "Streaming Motion Lab" spec: 24 word-by-word reveals).
 *
 * DESIGN CONTRACT
 * ───────────────
 * - The streaming engine (letter-stream / markdown FadeWords) renders every
 *   newly revealed word as a `.wf` span with an INLINE animationDuration
 *   (180–360ms, pace-mapped). The ANIMATION ITSELF comes from CSS.
 * - The default (no override) is the app's own mixed blur settle
 *   (word-settle-in, globals.css) — the identity.
 * - A selection is applied as `html[data-stream-anim="a12"]`;
 *   streaming-animations.css maps that attribute onto the 24 lab
 *   keyframes. Any ancestor carrying the attribute works, which is how the
 *   Settings preview plays an animation without changing the global pick.
 * - Persistence mirrors the appearance engine: localStorage + boot applier
 *   (providers), never a React re-render (the attribute swap is all CSS).
 * - Reduced motion: the sheet carries its own kill switch (the attribute
 *   selector outranks the base `.wf` rule, so it must kill itself too).
 */

export const STREAMING_ANIM_STORAGE_KEY = "onyx.streaming-anim";

/** The lab's 24 animations, in order (id → CSS keyframe sa-<id>). */
export interface StreamingAnimation {
  id: string;
  label: string;
}

export const STREAMING_ANIMATIONS: readonly StreamingAnimation[] = [
  { id: "a1", label: "Soft Dissolve" },
  { id: "a2", label: "Velvet Fade" },
  { id: "a3", label: "Cinematic Focus" },
  { id: "a4", label: "Typewriter" },
  { id: "a5", label: "Floating Rise" },
  { id: "a6", label: "Right Drift" },
  { id: "a7", label: "Satin Fade" },
  { id: "a8", label: "Gentle Ripple" },
  { id: "a9", label: "Warm Glow" },
  { id: "a10", label: "Left Slide" },
  { id: "a11", label: "3D Flip" },
  { id: "a12", label: "Blur Wave" },
  { id: "a13", label: "Micro Pop" },
  { id: "a14", label: "Light Sweep" },
  { id: "a15", label: "Weightless Float" },
  { id: "a16", label: "Horizontal Glide" },
  { id: "a17", label: "Neon Resolve" },
  { id: "a18", label: "Soft Scale" },
  { id: "a19", label: "Silk Wave" },
  { id: "a20", label: "Mist Clearing" },
  { id: "a21", label: "Gentle Spring" },
  { id: "a22", label: "Top Cascade" },
  { id: "a23", label: "Reading Scan" },
  { id: "a24", label: "Breathing Text" },
] as const;

const VALID_IDS = new Set(STREAMING_ANIMATIONS.map((a) => a.id));

/** True when `id` names one of the 24 selectable animations. */
export function isValidStreamingAnim(id: string | null | undefined): id is string {
  return typeof id === "string" && VALID_IDS.has(id);
}

/** Apply a selection: `html[data-stream-anim]`. Null → the default settle. */
export function applyStreamingAnim(id: string | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (isValidStreamingAnim(id)) {
    root.dataset.streamAnim = id as string;
  } else {
    delete root.dataset.streamAnim;
  }
}

/** The persisted selection, or null when the default settle is active. */
export function readPersistedStreamingAnim(): string | null {
  try {
    const raw = localStorage.getItem(STREAMING_ANIM_STORAGE_KEY);
    if (isValidStreamingAnim(raw)) return raw;
  } catch {
    /* storage unavailable — session-only */
  }
  return null;
}

/** Persist + apply a selection (invalid ids fall back to default). */
export function selectStreamingAnim(id: string | null): void {
  applyStreamingAnim(id);
  try {
    if (isValidStreamingAnim(id)) {
      localStorage.setItem(STREAMING_ANIM_STORAGE_KEY, id as string);
    } else {
      localStorage.removeItem(STREAMING_ANIM_STORAGE_KEY);
    }
  } catch {
    /* storage unavailable — session-only */
  }
}

/** Boot applier: restore the persisted selection before the first stream. */
export function applyPersistedStreamingAnim(): void {
  applyStreamingAnim(readPersistedStreamingAnim());
}

/** Reset to the default mixed blur settle. */
export function resetStreamingAnim(): void {
  selectStreamingAnim(null);
}
