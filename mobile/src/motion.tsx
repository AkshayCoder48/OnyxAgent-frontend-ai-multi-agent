import React, { useEffect, useId, type ReactNode } from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Motion system — every number here exists to make the glass feel alive:
 * springy presses, staggered blur-in entrances, ambient loops. Transform and
 * opacity only; blur is web-only, one-shot, ≤6px on small surfaces.
 */

export const SPRING = {
  butter: { damping: 18, mass: 0.5, stiffness: 350 }, // the default feel
  snap: { damping: 16, mass: 0.3, stiffness: 520 },   // press-in
  soft: { damping: 24, mass: 0.85, stiffness: 160 },  // large surfaces
} as const;

const IS_WEB = Platform.OS === 'web';
const EASE_INOUT = Easing.inOut(Easing.sin);

export function PressScale({
  children,
  scale = 0.94,
  spring,
  style,
  ...press
}: PressableProps & { scale?: number; spring?: object; style?: object }) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Pressable
      {...press}
      onPressIn={(e) => {
        s.value = withSpring(scale, { ...SPRING.snap, ...(spring as object) });
        press.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.value = withSpring(1, SPRING.butter);
        press.onPressOut?.(e);
      }}
    >
      <Animated.View style={[a, style as object]}>{children as ReactNode}</Animated.View>
    </Pressable>
  );
}

/** One-shot entrance: spring rise + (web-only) motion-blur settle. */
export function Enter({
  children,
  delay = 0,
  dur = 260,
  y = 16,
  from = 0.96,
  blur = 6,
  style,
}: {
  children?: ReactNode;
  delay?: number;
  dur?: number;
  y?: number;
  from?: number;
  blur?: number;
  style?: object;
}) {
  const p = useSharedValue(0);
  useEffect(() => {
    const t = setTimeout(() => {
      p.value = withTiming(1, { duration: dur, easing: Easing.out(Easing.cubic) });
    }, Math.max(0, delay));
    return () => clearTimeout(t);
  }, [delay, dur]);
  const a = useAnimatedStyle(() => {
    const t = p.value;
    const st: Record<string, unknown> = {
      opacity: t,
      transform: [{ translateY: y * (1 - t) }, { scale: from + (1 - from) * t }],
    };
    if (IS_WEB && blur > 0) st.filter = `blur(${((1 - t) * blur).toFixed(2)}px)`;
    return st as never;
  });
  return (
    <Animated.View style={[a, style as object]}>
      {children}
    </Animated.View>
  );
}

/** Stagger helper — pass index, get a delay in ms (capped). */
export const stagger = (i: number, step = 45, cap = 640) => Math.min(i * step, cap);

/** CSS `breathe` — 4.5s ease-in-out scale loop (gal-orb, ob-orb). */
export function Breathe({ to = 1.045, dur = 4500, style, children }: { to?: number; dur?: number; style?: object; children?: ReactNode }) {
  const s = useSharedValue(1);
  useEffect(() => {
    const half = dur / 2;
    s.value = withRepeat(
      withSequence(
        withTiming(to, { duration: half, easing: EASE_INOUT }),
        withTiming(1, { duration: half, easing: EASE_INOUT }),
      ),
      -1,
      false,
    );
  }, [dur, to]);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Animated.View style={[a, style as object]}>{children}</Animated.View>
  );
}

/** CSS `pulse` — 1.2-1.3s opacity loop for live dots. */
export function Pulse({ low = 0.3, dur = 1300, style, children }: { low?: number; dur?: number; style?: object; children?: ReactNode }) {
  const o = useSharedValue(1);
  useEffect(() => {
    const half = dur / 2;
    o.value = withRepeat(
      withSequence(
        withTiming(low, { duration: half, easing: EASE_INOUT }),
        withTiming(1, { duration: half, easing: EASE_INOUT }),
      ),
      -1,
      false,
    );
  }, [dur, low]);
  const a = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View style={[a, style as object]}>{children}</Animated.View>
  );
}

/** CSS `bob` — 4.5s drift loop (the showcase cursor). */
export function Bob({ dx = 3, dy = 4, dur = 4500, style, children }: { dx?: number; dy?: number; dur?: number; style?: object; children?: ReactNode }) {
  const x = useSharedValue(0);
  useEffect(() => {
    const half = dur / 2;
    x.value = withRepeat(
      withSequence(
        withTiming(1, { duration: half, easing: EASE_INOUT }),
        withTiming(0, { duration: half, easing: EASE_INOUT }),
      ),
      -1,
      false,
    );
  }, [dur]);
  const a = useAnimatedStyle(() => {
    const t = x.value;
    return { transform: [{ translateX: dx * t }, { translateY: dy * t }] } as never;
  });
  return (
    <Animated.View style={[a, style as object]}>{children}</Animated.View>
  );
}

/** Soft radial glow layer — the CSS `box-shadow: 0 0 Npx glow` equivalent. */
export function Halo({
  color,
  size,
  strength = 0.5,
  style,
}: {
  color: string;
  size: number;
  strength?: number;
  style?: object;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <Svg width={size} height={size} style={[{ position: 'absolute' } as object, style as object]} pointerEvents="none">
      <Defs>
        <RadialGradient id={`halo${id}`} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={strength} />
          <Stop offset="0.6" stopColor={color} stopOpacity={strength * 0.35} />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width={size} height={size} fill={`url(#halo${id})`} />
    </Svg>
  );
}
