import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_ORB_VARIANTS,
  buildCustomPersonality,
  FRIENDLY_PRESET,
  FOCUSED_PRESET,
  intensityToDurationScale,
  PERSONALITY_PRESETS,
  PLAYFUL_PRESET,
  PROFESSIONAL_PRESET,
  ORB_REACTION_STATES,
  resolveOrb,
  sanitizePersonality,
  type OrbPersonality,
  type OrbReactionState,
} from "./personalities";
import { useOrbPersonalityStore, setOrbOverrideState, clearOrbOverrideState } from "@/stores/orb-personality-store";

const VALID = new Set<string>(ALL_ORB_VARIANTS);

/** A personality whose state map is missing entries (simulates a stale
 * persisted shape). */
const PARTIAL: OrbPersonality = {
  ...PROFESSIONAL_PRESET,
  stateVariants: { idle: "C2" } as unknown as Record<OrbReactionState, never>,
};

describe("PERSONALITY_PRESETS", () => {
  it("has exactly the four fixed presets", () => {
    expect(Object.keys(PERSONALITY_PRESETS).sort()).toEqual(
      ["focused", "friendly", "playful", "professional"].sort(),
    );
  });

  it("maps all 9 reaction states to valid variants for every preset", () => {
    expect(ORB_REACTION_STATES).toHaveLength(9);
    for (const preset of Object.values(PERSONALITY_PRESETS)) {
      for (const state of ORB_REACTION_STATES) {
        const v = preset.stateVariants[state];
        expect(VALID.has(v), `${preset.id}.${state} = ${v}`).toBe(true);
      }
      expect(preset.reactionIntensity).toBeGreaterThanOrEqual(0);
      expect(preset.reactionIntensity).toBeLessThanOrEqual(1);
    }
  });

  it("Professional: calm and minimal (low intensity, no celebration)", () => {
    expect(PROFESSIONAL_PRESET.reactionIntensity).toBeLessThanOrEqual(0.3);
    expect(PROFESSIONAL_PRESET.celebrationEnabled).toBe(false);
    expect(PROFESSIONAL_PRESET.idleMotion).toBe("subtle");
  });

  it("Friendly: warm S-family idle wave and the gentle S1 success", () => {
    expect(FRIENDLY_PRESET.stateVariants.idle.startsWith("S")).toBe(true);
    expect(FRIENDLY_PRESET.stateVariants.success).toBe("S1");
    expect(FRIENDLY_PRESET.idleMotion).toBe("warm");
  });

  it("Focused: every state uses a DISTINCT variant (strong distinction)", () => {
    const variants = ORB_REACTION_STATES.map((s) => FOCUSED_PRESET.stateVariants[s]);
    expect(new Set(variants).size).toBe(ORB_REACTION_STATES.length);
    // M-family marches own the working states, per the PRD's "distinct,
    // steady activity animation" for Working.
    expect(FOCUSED_PRESET.stateVariants.tool_running.startsWith("M")).toBe(true);
    expect(FOCUSED_PRESET.idleMotion).toBe("none");
  });

  it("Playful: expressive comets, celebration on, higher intensity", () => {
    expect(PLAYFUL_PRESET.celebrationEnabled).toBe(true);
    expect(PLAYFUL_PRESET.reactionIntensity).toBeGreaterThanOrEqual(0.7);
    expect(PLAYFUL_PRESET.stateVariants.idle.startsWith("C")).toBe(true);
    expect(PLAYFUL_PRESET.stateVariants.success).toBe("G3");
  });
});

describe("intensityToDurationScale", () => {
  it("maps the extremes: calm slow, expressive fast", () => {
    expect(intensityToDurationScale(0)).toBeCloseTo(1.3);
    expect(intensityToDurationScale(1)).toBeCloseTo(0.7);
    expect(intensityToDurationScale(0.5)).toBeCloseTo(1.0);
  });

  it("is monotonically decreasing and clamped", () => {
    let prev = Infinity;
    for (let i = 0; i <= 10; i++) {
      const s = intensityToDurationScale(i / 10);
      expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(0.6);
      expect(s).toBeLessThanOrEqual(1.6);
      prev = s;
    }
    // Out-of-range inputs clamp to the same extremes.
    expect(intensityToDurationScale(-3)).toBeCloseTo(1.3);
    expect(intensityToDurationScale(2)).toBeCloseTo(0.7);
  });
});

describe("resolveOrb — normal motion", () => {
  it("returns the personality's variant per state, animated at the intensity speed", () => {
    for (const state of ORB_REACTION_STATES) {
      const r = resolveOrb(PLAYFUL_PRESET, state, false);
      expect(r.variant).toBe(PLAYFUL_PRESET.stateVariants[state]);
      expect(r.animate).toBe(true);
      expect(r.durationScale).toBeCloseTo(intensityToDurationScale(0.8));
    }
    // Higher intensity ⇒ faster (smaller scale) than lower intensity.
    const calm = resolveOrb(PROFESSIONAL_PRESET, "thinking", false);
    const lively = resolveOrb(PLAYFUL_PRESET, "thinking", false);
    expect(lively.durationScale).toBeLessThan(calm.durationScale);
  });

  it("falls back safely on a partial/stale state map", () => {
    const r = resolveOrb(PARTIAL, "thinking", false);
    expect(VALID.has(r.variant)).toBe(true);
    // Unmapped states fall back to the personality's own idle variant (if
    // valid); a completely broken map falls back to the safe S1 swell.
    expect(resolveOrb(PARTIAL, "thinking", false).variant).toBe("C2");
    expect(resolveOrb(PARTIAL, "idle", false).variant).toBe("C2");
    const broken = { ...PARTIAL, stateVariants: {} } as unknown as OrbPersonality;
    expect(resolveOrb(broken, "thinking", false).variant).toBe("S1");
  });
});

describe("resolveOrb — reduced motion", () => {
  it("renders a static lattice for non-working states", () => {
    for (const state of ["idle", "user_typing", "success", "error", "cancelled"] as const) {
      const r = resolveOrb(FRIENDLY_PRESET, state, true);
      expect(r.animate).toBe(false);
      expect(r.variant).toBe(FRIENDLY_PRESET.stateVariants[state]);
    }
  });

  it("keeps ONE slow subtle pulse for working states (S1, ~7s cycle)", () => {
    for (const state of ["submitted", "thinking", "tool_running", "awaiting_approval"] as const) {
      const r = resolveOrb(FRIENDLY_PRESET, state, true);
      expect(r.animate).toBe(true);
      expect(r.variant).toBe("S1");
      expect(r.durationScale).toBeGreaterThan(3);
    }
  });

  it("Focused (idleMotion none) stays fully static, even while working", () => {
    for (const state of ORB_REACTION_STATES) {
      expect(resolveOrb(FOCUSED_PRESET, state, true).animate).toBe(false);
    }
  });
});

describe("custom personality helpers", () => {
  it("buildCustomPersonality seeds from a base preset", () => {
    const c = buildCustomPersonality(FRIENDLY_PRESET);
    expect(c.id).toBe("custom");
    expect(c.label).toBe("Custom");
    expect(c.stateVariants).toEqual(FRIENDLY_PRESET.stateVariants);
    expect(c).not.toBe(FRIENDLY_PRESET); // a copy, not the preset itself
  });

  it("sanitizePersonality repairs stale shapes", () => {
    const s = sanitizePersonality({
      reactionIntensity: 7, // out of range → clamped
      stateVariants: { idle: "M3", thinking: "not-a-variant" }, // partial
      idleMotion: "bogus" as never,
    });
    expect(s.id).toBe("custom");
    expect(s.reactionIntensity).toBe(1);
    expect(s.idleMotion).toBe("subtle"); // seed default
    expect(s.stateVariants.idle).toBe("M3"); // valid value kept
    expect(VALID.has(s.stateVariants.thinking)).toBe(true); // repaired
    // undefined input → the full seed
    expect(sanitizePersonality(undefined).stateVariants.success).toBe(
      buildCustomPersonality().stateVariants.success,
    );
  });
});

describe("orb-personality store", () => {
  beforeEach(() => {
    useOrbPersonalityStore.setState({
      personalityId: "professional",
      custom: buildCustomPersonality(),
      overrideState: null,
    });
  });

  it("starts on the Professional preset", () => {
    expect(useOrbPersonalityStore.getState().personalityId).toBe("professional");
  });

  it("switches presets", () => {
    useOrbPersonalityStore.getState().setPersonality("playful");
    expect(useOrbPersonalityStore.getState().personalityId).toBe("playful");
  });

  it("switching to custom seeds the copy from the CURRENT preset", () => {
    useOrbPersonalityStore.getState().setPersonality("friendly");
    useOrbPersonalityStore.getState().setPersonality("custom");
    const { personalityId, custom } = useOrbPersonalityStore.getState();
    expect(personalityId).toBe("custom");
    expect(custom.id).toBe("custom");
    expect(custom.stateVariants.success).toBe("S1"); // inherited from Friendly
  });

  it("patchCustom applies while custom is active and can't smuggle a preset id", () => {
    useOrbPersonalityStore.getState().setPersonality("custom");
    useOrbPersonalityStore.getState().patchCustom({ reactionIntensity: 0.9 });
    expect(useOrbPersonalityStore.getState().custom.reactionIntensity).toBe(0.9);
    useOrbPersonalityStore
      .getState()
      .patchCustom({ id: "friendly" } as never); // must be ignored
    expect(useOrbPersonalityStore.getState().custom.id).toBe("custom");
  });

  it("patchCustom is a no-op while a preset is active", () => {
    useOrbPersonalityStore.getState().patchCustom({ reactionIntensity: 0.9 });
    expect(useOrbPersonalityStore.getState().custom.reactionIntensity).toBe(
      buildCustomPersonality().reactionIntensity,
    );
  });

  it("resetCustom restores the seed defaults", () => {
    useOrbPersonalityStore.getState().setPersonality("custom");
    useOrbPersonalityStore.getState().patchCustom({ celebrationEnabled: true });
    useOrbPersonalityStore.getState().resetCustom();
    const { custom } = useOrbPersonalityStore.getState();
    expect(custom).toEqual(buildCustomPersonality());
  });

  it("override state is transient set/clear (the Task 2-d contract)", () => {
    useOrbPersonalityStore.getState().setOverrideState("awaiting_approval");
    expect(useOrbPersonalityStore.getState().overrideState).toBe("awaiting_approval");
    useOrbPersonalityStore.getState().clearOverrideState();
    expect(useOrbPersonalityStore.getState().overrideState).toBeNull();
  });

  it("standalone override setters drive the store (call-from-anywhere API)", () => {
    setOrbOverrideState("awaiting_approval");
    expect(useOrbPersonalityStore.getState().overrideState).toBe("awaiting_approval");
    // The EXACT Task 2-d contract: a resolved gate calls setOrbOverrideState(null).
    setOrbOverrideState(null);
    expect(useOrbPersonalityStore.getState().overrideState).toBeNull();
    setOrbOverrideState("error");
    clearOrbOverrideState();
    expect(useOrbPersonalityStore.getState().overrideState).toBeNull();
  });

  it("persists under the onyx-orb-personality key and never persists the override", async () => {
    // Node has no localStorage — the statically imported store silently
    // skipped its persist attachment. Stub a minimal localStorage, reset the
    // module registry, and import a FRESH store instance so the persist
    // middleware actually engages.
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    try {
      vi.resetModules();
      const mod = await import("@/stores/orb-personality-store");
      const fresh = mod.useOrbPersonalityStore;
      expect(fresh.persist).toBeDefined();
      expect(fresh.persist!.getOptions().name).toBe("onyx-orb-personality");

      fresh.getState().setOverrideState("error");
      const partialize = fresh.persist!.getOptions()
        .partialize as (s: unknown) => Record<string, unknown>;
      const persisted = partialize(fresh.getState());
      expect(persisted).not.toHaveProperty("overrideState");
      expect(persisted).toHaveProperty("personalityId");
      expect(persisted).toHaveProperty("custom");

      // A real write lands in the stubbed storage under the right key.
      fresh.getState().setPersonality("playful");
      const raw = storage.get("onyx-orb-personality");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).state.personalityId).toBe("playful");
      expect(JSON.parse(raw!).state).not.toHaveProperty("overrideState");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
