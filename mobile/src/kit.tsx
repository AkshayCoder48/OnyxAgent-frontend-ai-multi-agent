/**
 * OnyxAgent glass kit — every component is a 1:1 port of a CSS class from
 * three-ui-clones (1).html, in the clone's design units (276×570 phone).
 * Sizes are NOT scaled here; the Scaled wrapper scales whole screens.
 */
import React, { useMemo, useState, type ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Svg, { Defs, RadialGradient, Circle, Path, Stop } from 'react-native-svg';
import { useId } from 'react';

import { useAccent } from './accent';
import { useSidebar } from './sidebar-context';
import { GREEN, GREEN_SOFT, WARN, hexToHue, hslToHex, PRESETS, rgba, type Tones } from './theme';
import { Icon, type IconName } from './icons';
import { Breathe, Enter, Halo, PressScale, Pulse, stagger, SPRING } from './motion';

export const DESIGN_W = 276;
export const DESIGN_H = 570;
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;

const T = ({ children, style, ...rest }: TextProps & { children?: ReactNode; style?: object }) => (
  <Text {...rest} style={[style as object]}>{children}</Text>
);
export const Dot = (a: number) => `rgba(255,255,255,${a})`;

/* ---------------------------------- screens --------------------------------- */

export type ScreenKind = 'home' | 'tools' | 'chat' | 'side' | 'plain' | 'onboard';

export function Screen({ kind, children, style }: { kind: ScreenKind; children?: ReactNode; style?: object }) {
  const { tones } = useAccent();
  const stops: [string, ...string[]] =
    kind === 'home' ? tones.scrHome
    : kind === 'tools' ? tones.scrTools
    : kind === 'chat' || kind === 'side' ? tones.scrChat
    : kind === 'onboard' ? [rgba(tones.acc, 0.30), '#0a0300', '#050100']
    : tones.scrPlain;
  return (
    <View style={[{ flex: 1, position: 'relative' } as object, style as object]}>
      {kind === 'onboard' && (
        <Halo color={rgba(tones.acc, 0.5)} size={340} strength={0.38} style={{ top: -90, alignSelf: 'center' }} />
      )}
      <LinearGradient colors={stops as never} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}

/** Phone chrome — island + 9:41 status bar (gallery frames only). */
export function PhoneChrome() {
  return (
    <>
      <View
        style={{
          position: 'absolute', top: 13, left: 0, right: 0, alignItems: 'center', zIndex: 6,
        }}
        pointerEvents="none"
      >
        <View
          style={{
            width: 86, height: 25, borderRadius: 999, backgroundColor: '#000',
            alignItems: 'flex-end', justifyContent: 'center', paddingRight: 8,
          }}
        >
          <View
            style={{
              width: 10, height: 10, borderRadius: 999,
              backgroundColor: '#16181e',
              borderWidth: 1, borderColor: 'rgba(80,90,120,.6)',
            }}
          />
        </View>
      </View>
      <View
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          paddingHorizontal: 22, paddingTop: 14,
        }}
        pointerEvents="none"
      >
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.2 }}>9:41</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="signal" size={17} color="#fff" />
          <Icon name="wifi" size={15} color="#fff" />
          <Icon name="batt" size={24} color="#fff" />
        </View>
      </View>
    </>
  );
}

/** The clone's phone frame. */
export function PhoneFrame({ children, style }: { children?: ReactNode; style?: object }) {
  return (
    <View
      style={[
        {
          width: DESIGN_W, height: DESIGN_H, backgroundColor: '#0a0705',
          borderRadius: 42, padding: 4,
          shadowColor: '#000', shadowOpacity: 0.85, shadowRadius: 90, shadowOffset: { width: 0, height: 46 },
          borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.06)',
        } as object,
        style as object,
      ]}
    >
      <View style={{ flex: 1, borderRadius: 38, overflow: 'hidden', backgroundColor: '#0b0200' }}>
        {children}
      </View>
    </View>
  );
}

/** Scale a fixed-design child to fill the window. */
export function Scaled({
  w = DESIGN_W, h = DESIGN_H, max = 1.62, children, style,
}: { w?: number; h?: number; max?: number; children?: ReactNode; style?: object }) {
  const win = useWindowDimensions();
  const scale = Math.min(win.width / w, (win.height - 8) / h, max);
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } as object, style as object]}>
      <View style={{ width: w, height: h, transform: [{ scale }] }}>{children}</View>
    </View>
  );
}

/* ----------------------------------- glass ---------------------------------- */

const glassShadow = (opacity = 0.28, radius = 26, height = 10): ViewStyle => ({
  shadowColor: '#000', shadowOpacity: opacity, shadowRadius: radius, shadowOffset: { width: 0, height },
});

export function GlassCard({ children, style, blur = true, glow = false }: { children?: ReactNode; style?: object; blur?: boolean; glow?: boolean }) {
  const { tones } = useAccent();
  return (
    <View
      style={[
        {
          position: 'relative', borderRadius: 15, overflow: 'hidden',
          backgroundColor: 'rgba(255,255,255,0.09)',
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)',
          borderTopColor: 'rgba(255,255,255,0.30)',
          padding: 9, ...glassShadow(),
        } as object,
        style as object,
      ]}
    >
      {blur && (
        <BlurView intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
      )}
      {glow && <Halo color={tones.glow(0.35)} size={120} strength={0.3} style={{ alignSelf: 'center' }} />}
      <View style={{ position: 'relative', zIndex: 1 }}>{children}</View>
    </View>
  );
}

export function GlassPill({ children, style }: { children?: ReactNode; style?: object }) {
  return (
    <View
      style={[
        {
          flexDirection: 'row', alignItems: 'center', gap: 5, height: 27, paddingHorizontal: 12,
          borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.10)',
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
          borderTopColor: 'rgba(255,255,255,0.26)',
        } as object,
        style as object,
      ]}
    >
      {children}
    </View>
  );
}

export function GBtn({ icon, size = 15, onPress, rotate, testID }: { icon: IconName; size?: number; onPress?: () => void; rotate?: number; testID?: string }) {
  return (
    <PressScale onPress={onPress} style={{ width: 30, height: 30 }} testID={testID} accessibilityLabel={testID?.replace(/^btn-/, '').replace(/-/g, ' ')} accessibilityRole="button">
      <View
        style={{
          width: 30, height: 30, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
          borderTopColor: 'rgba(255,255,255,0.26)', ...glassShadow(0.18, 14, 4),
        }}
      >
        <View style={rotate ? { transform: [{ rotate: `${rotate}deg` }] } : undefined}>
          <Icon name={icon} size={size} color="rgba(255,255,255,0.9)" />
        </View>
      </View>
    </PressScale>
  );
}

/* ------------------------------- chat pieces -------------------------------- */

export function ChatHeader({
  model, role, leftIcon = 'panel', onLeft, rightIcon = 'share', onRight,
}: { model: string; role: string; onLeft?: () => void; leftIcon?: IconName; rightIcon?: IconName; onRight?: () => void }) {
  const sidebar = useSidebar();
  const openLeft = onLeft ?? (leftIcon === 'panel' ? sidebar.open : undefined);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 4 }}>
      <GBtn icon={leftIcon} onPress={openLeft} testID="btn-sidebar" />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <GlassPill>
          <T style={{ color: '#fff', fontSize: 10.5, fontWeight: '600' }}>{model}</T>
          <T style={{ color: Dot(0.45), fontSize: 10.5 }}>·</T>
          <T style={{ color: 'rgba(255,255,255,0.92)', fontSize: 10.5, fontWeight: 500 }}>{role}</T>
        </GlassPill>
      </View>
      <GBtn icon={rightIcon} size={14} onPress={onRight} />
    </View>
  );
}

export function ChatBar({ placeholder = 'Ask AI a question', icon = 'clip', tail = 'mic' }: { placeholder?: string; icon?: IconName; tail?: IconName }) {
  return (
    <View
      style={{
        marginHorizontal: 12, marginTop: 12, marginBottom: 13, minHeight: 41, borderRadius: 16,
        flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 15, paddingVertical: 6,
        backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
        borderTopColor: 'rgba(255,255,255,0.26)',
      }}
    >
      <Icon name={icon} size={15} color="rgba(255,255,255,0.7)" />
      <T style={{ flex: 1, fontSize: 11.5, color: Dot(0.5) }}>{placeholder}</T>
      <Icon name={tail} size={15} color="rgba(255,255,255,0.58)" />
    </View>
  );
}

export function Orb({ size = 15, glow = true }: { size?: number; glow?: boolean }) {
  const { tones } = useAccent();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const r = size / 2;
  return (
    <View style={{ width: size, height: size }}>
      {glow && <Halo color={tones.glow()} size={size * 3.4} strength={0.5} style={{ left: -(size * 1.2), top: -(size * 1.2) }} />}
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={`orb${id}`} cx="33%" cy="28%" r="72%">
            <Stop offset="0" stopColor={tones.accPale} />
            <Stop offset="0.18" stopColor={tones.accHi} />
            <Stop offset="0.45" stopColor={tones.acc} />
            <Stop offset="0.75" stopColor={rgba(tones.acc, 0.55)} />
            <Stop offset="1" stopColor={rgba(tones.acc, 0.88)} />
          </RadialGradient>
        </Defs>
        <Circle cx={r} cy={r} r={r} fill={`url(#orb${id})`} />
      </Svg>
    </View>
  );
}

export function MsgU({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <LinearGradient
      colors={tones.bubble}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={{
        alignSelf: 'flex-end', maxWidth: '78%', borderTopLeftRadius: 15, borderTopRightRadius: 15,
        borderBottomLeftRadius: 5, borderBottomRightRadius: 15,
        paddingHorizontal: 11, paddingVertical: 8,
        shadowColor: tones.acc, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 4 },
      }}
    >
      <T style={{ color: '#fff', fontSize: 11, lineHeight: 17 }}>{children}</T>
    </LinearGradient>
  );
}

export function MsgAI({ children }: { children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, maxWidth: '96%' }}>
      <View style={{ marginTop: 2 }}>
        <Orb size={15} />
      </View>
      <T style={{ flex: 1, fontSize: 11, lineHeight: 17.5, color: Dot(0.9) }}>{children}</T>
    </View>
  );
}

/** accent-tinted span inside an AI message */
export function HL({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return <T style={{ color: tones.accXh, fontWeight: '600' }}>{children}</T>;
}

export function MEN({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <T
      style={{
        color: tones.accXh, fontWeight: '600', fontSize: 10,
        backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
        paddingHorizontal: 5, borderRadius: 6, overflow: 'hidden',
      }}
    >
      {children}
    </T>
  );
}

export function RateRow() {
  const { tones } = useAccent();
  const items: IconName[] = ['speak', 'copy', 'thumb', 'redo', 'share'];
  return (
    <View style={{ flexDirection: 'row', gap: 14, marginLeft: 23, marginTop: 2 }}>
      {items.map((n, i) => (
        <Enter key={n} delay={stagger(i, 40)}>
          <PressScale scale={0.85}>
            <Icon name={n} size={13} color={Dot(0.42)} />
          </PressScale>
        </Enter>
      ))}
      <View style={{ width: 1 }} />
    </View>
  );
}

export function WorkingLine({ children }: { children?: ReactNode }) {
  return (
    <T style={{ marginLeft: 23, marginTop: 2, fontSize: 10, color: Dot(0.42) }}>{children}</T>
  );
}

export function ThinkLine({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 23, marginTop: 1 }}>
      <Icon name="spark" size={11} color={tones.accXh} />
      <T style={{ fontSize: 9.5, color: Dot(0.52) }}>{children}</T>
    </View>
  );
}

/* --------------------------------- tool cards ------------------------------- */

export function StateDot({ state = 'run', size = 6 }: { state?: 'run' | 'done' | 'queued' | 'warn'; size?: number }) {
  const { tones } = useAccent();
  if (state === 'run')
    return (
      <Pulse>
        <View style={{ width: size, height: size, borderRadius: 999, backgroundColor: tones.accXh, shadowColor: tones.glow(), shadowOpacity: 0.9, shadowRadius: 8 }} />
      </Pulse>
    );
  const bg = state === 'done' ? GREEN : state === 'warn' ? WARN : Dot(0.35);
  return <View style={{ width: size, height: size, borderRadius: 999, backgroundColor: bg as string }} />;
}

export function ToolBatch({
  title = 'Used 10 tools', dur = '6s', chips, out,
}: { title?: string; dur?: string; chips: Array<{ t: string; d?: 'done' | 'run' | 'warn' | 'idle' }>; out?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <View style={{ marginLeft: 23 }}>
      <GlassCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon name="spark" size={13} color={tones.accXh} />
          <T style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{title}</T>
          <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="clockic" size={10} color={Dot(0.5)} />
            <T style={{ fontSize: 9, color: Dot(0.5) }}>{dur}</T>
            <Icon name="chev" size={11} color={Dot(0.5)} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
          {chips.map((c, i) => (
            <Enter key={c.t} delay={stagger(i, 50)}>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 5, height: 21, paddingHorizontal: 8,
                  borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
                }}
              >
                <StateDot state={c.d === 'idle' ? 'queued' : c.d ?? 'done'} size={5} />
                <T style={{ fontFamily: MONO, fontSize: 8.5, color: Dot(0.72) }}>{c.t}</T>
              </View>
            </Enter>
          ))}
        </View>
        {out != null && (
          <View
            style={{
              marginTop: 7, borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.5)',
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 9, paddingVertical: 7,
            }}
          >
            <T style={{ fontSize: 9.5, lineHeight: 15, color: Dot(0.72) }}>{out}</T>
          </View>
        )}
      </GlassCard>
    </View>
  );
}

export function CodeCard({
  title, meta, children, onCopy, state,
}: { title: string; meta?: string; children?: ReactNode; onCopy?: boolean; state?: 'done' | 'run' | null }) {
  const { tones } = useAccent();
  return (
    <View style={{ marginLeft: 23 }}>
      <GlassCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
          <T style={{ fontSize: 8.5, fontWeight: '600', color: Dot(0.5), textTransform: 'uppercase', letterSpacing: 0.8 }}>
            {title}
          </T>
          {meta ? <T style={{ fontSize: 8, color: Dot(0.35) }}>{meta}</T> : null}
          {state && (
            <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <T style={{ fontSize: 9, color: Dot(0.55) }}>{state === 'done' ? 'Done' : 'Working'}</T>
              <StateDot state={state} size={6} />
            </View>
          )}
          {onCopy && !state && (
            <View style={{ marginLeft: 'auto' }}>
              <PressScale scale={0.85}>
                <Icon name="copy" size={11} color={Dot(0.45)} />
              </PressScale>
            </View>
          )}
        </View>
        <View
          style={{
            borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
            paddingHorizontal: 9, paddingVertical: 7,
          }}
        >
          <T style={{ fontFamily: MONO, fontSize: 8.8, lineHeight: 15, color: tones.codeStr }}>{children}</T>
        </View>
      </GlassCard>
    </View>
  );
}

export const Dim = ({ children }: { children?: ReactNode }) => <T style={{ color: Dot(0.34) }}>{children}</T>;
export const OKS = ({ children }: { children?: ReactNode }) => <T style={{ color: GREEN }}>{children}</T>;
export const STR = ({ children }: { children?: ReactNode }) => {
  const { tones } = useAccent();
  return <T style={{ color: tones.accSoft }}>{children}</T>;
};

export function DiffLine({ kind, children }: { kind: 'add' | 'rem'; children?: ReactNode }) {
  return (
    <T
      style={[
        {
          fontFamily: MONO, fontSize: 8.6, lineHeight: 14, paddingHorizontal: 7, paddingVertical: 1,
          borderRadius: 5, overflow: 'hidden',
        },
        kind === 'add'
          ? { backgroundColor: 'rgba(110,220,150,0.11)', color: GREEN_SOFT }
          : { backgroundColor: 'rgba(255,110,110,0.10)', color: '#FFA9A9' },
      ]}
    >
      {children}
    </T>
  );
}

/* -------------------------------- sidebar rail ------------------------------ */

export function SideItem({
  icon, title, time, on = false, onPress, iconTint,
}: { icon: IconName; title: string; time?: string; on?: boolean; onPress?: () => void; iconTint?: string }) {
  const { tones } = useAccent();
  return (
    <PressScale scale={0.97} onPress={onPress} style={{ borderRadius: 11 }}>
      <View
        style={[
          {
            flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, paddingVertical: 8,
            borderRadius: 11, borderWidth: 1.2, borderColor: 'transparent',
          },
          on
            ? {
                backgroundColor: 'rgba(255,255,255,0.28)', borderColor: 'rgba(255,255,255,0.92)',
                shadowColor: 'rgba(255,255,255,0.16)', shadowOpacity: 1, shadowRadius: 22, shadowOffset: { width: 0, height: 0 },
              }
            : undefined,
        ]}
      >
        <Icon name={icon} size={13} color={on ? tones.accPale : (iconTint ?? Dot(0.48))} />
        <T
          numberOfLines={1}
          style={{ flex: 1, fontSize: 10.5, color: on ? '#fff' : Dot(0.76) }}
        >
          {title}
        </T>
        {time ? <T style={{ fontSize: 8.5, color: Dot(0.35) }}>{time}</T> : null}
      </View>
    </PressScale>
  );
}

export function SideLabel({ children }: { children?: ReactNode }) {
  return (
    <T style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.9, color: Dot(0.38), paddingTop: 5, paddingHorizontal: 2 }}>
      {children}
    </T>
  );
}

/* ------------------------------- settings rows ------------------------------ */

export function StHead({
  title, sub, back, right, onBack,
}: { title: string; sub?: string; back?: boolean; right?: ReactNode; onBack?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 12, paddingTop: 6 }}>
      {back && <GBtn icon="chevr" size={14} rotate={180} onPress={onBack} />}
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 14.5, fontWeight: '700', color: '#fff', letterSpacing: -0.2 }}>{title}</T>
        {sub ? <T style={{ fontSize: 9, color: Dot(0.4) }}>{sub}</T> : null}
      </View>
      {right}
    </View>
  );
}

export function SL({ children }: { children?: ReactNode }) {
  return (
    <T style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, color: Dot(0.38), marginTop: 8, marginHorizontal: 2, marginBottom: 2 }}>
      {children}
    </T>
  );
}

export function StFoot({ children }: { children?: ReactNode }) {
  return (
    <T style={{ textAlign: 'center', fontSize: 8.5, color: Dot(0.3), paddingTop: 10, paddingBottom: 2 }}>{children}</T>
  );
}

export function Row({
  icon, title, sub, end, onPress, children,
}: {
  icon?: IconName | ReactNode; title: ReactNode; sub?: string; end?: ReactNode; onPress?: () => void; children?: ReactNode;
}) {
  const tint = useAccentTint();
  return (
    <PressScale scale={0.98} onPress={onPress} disabled={!onPress} style={{ borderRadius: 13 }}>
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9,
          borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        }}
      >
        {icon != null && (
          <View
            style={{
              width: 27, height: 27, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
            }}
          >
            {typeof icon === 'string' ? <Icon name={icon} size={14} color={tint} /> : icon}
          </View>
        )}
        <View style={{ flex: 1 }}>
          <T numberOfLines={1} style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{title}</T>
          {sub ? <T numberOfLines={1} style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>{sub}</T> : null}
          {children}
        </View>
        {end != null && <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 7 }}>{end}</View>}
      </View>
    </PressScale>
  );
}

function useAccentTint() {
  const { tones } = useAccent();
  return tones.accXh;
}

export function Badge({ variant = 'acc', children }: { variant?: 'acc' | 'grn' | 'dim'; children?: ReactNode }) {
  const { tones } = useAccent();
  const st =
    variant === 'acc'
      ? { backgroundColor: rgba(tones.acc, 0.22), borderColor: rgba(tones.acc, 0.4), color: tones.accXh }
      : variant === 'grn'
        ? { backgroundColor: 'rgba(143,227,174,0.12)', borderColor: 'rgba(143,227,174,0.3)', color: GREEN }
        : { backgroundColor: 'rgba(255,255,255,0.07)', borderColor: 'rgba(255,255,255,0.12)', color: Dot(0.45) };
  return (
    <View
      style={{
        height: 17, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: st.backgroundColor as string, borderColor: st.borderColor as string,
      }}
    >
      <T style={{ fontSize: 8, fontWeight: '600', letterSpacing: 0.3, color: st.color as string }}>{children}</T>
    </View>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange?: (v: boolean) => void }) {
  const { tones } = useAccent();
  const v = useSharedValue(value ? 1 : 0);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: 2 + v.value * 14 }] }));
  const onLayer = useAnimatedStyle(() => ({ opacity: v.value }));
  return (
    <PressScale scale={0.9} onPress={() => { const nv = !value; v.value = withSpring(nv ? 1 : 0, SPRING.butter); onChange?.(nv); }}>
      <View style={{ width: 34, height: 20, borderRadius: 999, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.15)' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: 0 }, onLayer]}>
          <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View
          style={{
            position: 'absolute', top: 2, left: 0, width: 14, height: 14, borderRadius: 999,
            backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
            ...knob,
          }}
        />
      </View>
    </PressScale>
  );
}

export function Seg({
  options, value, onChange,
}: { options: Array<{ icon?: IconName; label: string }>; value: number; onChange?: (i: number) => void }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', gap: 5 }}>
      {options.map((o, i) => {
        const on = i === value;
        return (
          <PressScale
            key={o.label}
            scale={0.96}
            onPress={() => onChange?.(i)}
            style={{ flex: 1 }}
          >
            <View
              style={{
                height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                flexDirection: 'row', gap: 6, overflow: 'hidden',
                backgroundColor: on ? 'transparent' : 'rgba(255,255,255,0.07)',
                borderWidth: 1, borderColor: on ? 'transparent' : 'rgba(255,255,255,0.12)',
              }}
            >
              {on && (
                <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              )}
              {o.icon ? <Icon name={o.icon} size={12} color={on ? '#fff' : 'rgba(255,255,255,0.55)'} /> : null}
              <T style={{ fontSize: 10, fontWeight: '600', color: on ? '#fff' : 'rgba(255,255,255,0.55)' }}>{o.label}</T>
            </View>
          </PressScale>
        );
      })}
    </View>
  );
}

export function Field({ placeholder = '••••••••••••', leading = 'key' }: { placeholder?: string; leading?: IconName }) {
  return (
    <View
      style={{
        height: 34, borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11,
        backgroundColor: 'rgba(0,0,0,0.36)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
      }}
    >
      <Icon name={leading} size={13} color={Dot(0.55)} />
      <T style={{ flex: 1, fontFamily: MONO, fontSize: 10, letterSpacing: 2.5, color: Dot(0.65) }}>{placeholder}</T>
      <Icon name="slider" size={13} color={Dot(0.4)} />
    </View>
  );
}

/* --------------------------------- sources ---------------------------------- */

export function Fav({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <View
      style={{
        width: 20, height: 20, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
      }}
    >
      <T style={{ fontSize: 8.5, fontWeight: '700', color: tones.accXh }}>{children}</T>
    </View>
  );
}

export function SrcRow({
  fav, domain, title, desc, children,
}: { fav: string; domain: string; title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <Fav>{fav}</Fav>
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 8, color: Dot(0.4), letterSpacing: 0.3 }}>{domain}</T>
        <T style={{ fontSize: 10, color: Dot(0.9), marginTop: 2, lineHeight: 13.5, fontWeight: '500' }}>{title}</T>
        {desc != null && <T style={{ fontSize: 8.8, color: Dot(0.5), lineHeight: 13.5, marginTop: 2 }}>{desc}</T>}
        {children}
      </View>
    </View>
  );
}

export function Cites({ nums, note }: { nums: number[]; note?: string }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', gap: 5, marginLeft: 23, alignItems: 'center', flexWrap: 'wrap' }}>
      {nums.map((n) => (
        <View
          key={n}
          style={{
            width: 16, height: 16, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
          }}
        >
          <T style={{ fontSize: 8, fontWeight: '700', color: tones.accXh }}>{n}</T>
        </View>
      ))}
      {note ? <T style={{ fontSize: 8.5, color: Dot(0.4), marginLeft: 4 }}>{note}</T> : null}
    </View>
  );
}

export function FakeLine({ w, hl = false, mg }: { w: `${number}%`; hl?: boolean; mg?: number }) {
  const { tones } = useAccent();
  return (
    <View
      style={{
        height: 6, borderRadius: 3, width: w as `${number}%`, marginBottom: mg ?? 5,
        backgroundColor: hl ? rgba(tones.acc, 0.42) : 'rgba(255,255,255,0.10)',
        ...(hl ? { shadowColor: tones.glow(), shadowOpacity: 0.8, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } } : {}),
      }}
    />
  );
}

export const PageBlock = ({ h, style, children }: { h: number; style?: object; children?: ReactNode }) => (
  <View style={[{ height: h, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.09)' } as object, style as object]}>{children}</View>
);

/* --------------------------------- library ---------------------------------- */

export function Tile({ icon, label, st, more }: { icon: IconName; label: string; st?: string; more?: boolean }) {
  const { tones } = useAccent();
  if (more)
    return (
      <View
        style={{
          borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.11)',
          alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8,
        }}
      >
        <T style={{ fontSize: 11, color: Dot(0.6) }}>{label}</T>
        <T style={{ fontSize: 7, color: Dot(0.4) }}>more tools</T>
      </View>
    );
  return (
    <View
      style={{
        borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.11)',
        paddingVertical: 9, paddingHorizontal: 5, paddingBottom: 8, alignItems: 'center', gap: 5,
      }}
    >
      <View
        style={{
          width: 25, height: 25, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
        }}
      >
        <Icon name={icon} size={13} color={tones.accXh} />
      </View>
      <T style={{ fontSize: 8, lineHeight: 10, textAlign: 'center', color: Dot(0.72) }}>{label}</T>
      {st ? <T style={{ fontSize: 7, color: GREEN, letterSpacing: 0.3 }}>{st}</T> : null}
    </View>
  );
}

export const Tiles = ({ children }: { children?: ReactNode }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{children}</View>
);

export function SKCard({
  icon, title, sub, desc, installed, onInstall,
}: { icon: IconName; title: string; sub: string; desc: string; installed?: boolean; onInstall?: () => void }) {
  const { tones } = useAccent();
  return (
    <GlassCard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            width: 27, height: 27, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
          }}
        >
          <Icon name={icon} size={14} color={tones.accXh} />
        </View>
        <View style={{ flex: 1 }}>
          <T style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{title}</T>
          <T style={{ fontSize: 8.8, color: Dot(0.42) }}>{sub}</T>
        </View>
        <PressScale scale={0.92} onPress={onInstall}>
          <View
            style={[
              {
                height: 24, paddingHorizontal: 11, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              },
              installed
                ? { backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' }
                : { shadowColor: tones.glow(), shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
            ]}
          >
            {!installed && <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
            <T style={{ fontSize: 9, fontWeight: '600', color: installed ? Dot(0.6) : '#fff' }}>{installed ? 'Installed' : 'Install'}</T>
          </View>
        </PressScale>
      </View>
      <T style={{ fontSize: 9, color: Dot(0.55), lineHeight: 13.5, marginTop: 7 }}>{desc}</T>
    </GlassCard>
  );
}

export function UplBox({ children, style }: { children?: ReactNode; style?: object }) {
  return (
    <View
      style={[
        {
          borderWidth: 1.4, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.24)', borderRadius: 12,
          minHeight: 42, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7,
          backgroundColor: 'rgba(255,255,255,0.03)',
        } as object,
        style as object,
      ]}
    >
      <Icon name="up" size={13} color={Dot(0.5)} />
      <T style={{ fontSize: 10, color: Dot(0.5) }}>{children}</T>
    </View>
  );
}

export function PBar({ w = 64 }: { w?: number }) {
  const { tones } = useAccent();
  return (
    <View style={{ height: 5, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
      <LinearGradient
        colors={tones.bar}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={{ height: '100%', width: `${w}%` as `${number}%`, borderRadius: 99, shadowColor: tones.glow(), shadowOpacity: 0.8, shadowRadius: 8 }}
      />
    </View>
  );
}

export function BarsChart({ data, labels }: { data: number[]; labels: string[] }) {
  const { tones } = useAccent();
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 58, paddingHorizontal: 3 }}>
        {data.map((h, i) => {
          const lit = h > 60;
          return (
            <Enter key={i} delay={stagger(i, 55)} y={10} from={0.9}>
              <View style={{ flex: 1, height: `${h}%` as `${number}%`, justifyContent: 'flex-end', borderRadius: 5, borderTopLeftRadius: 5, overflow: 'hidden' }}>
                {lit ? (
                  <LinearGradient
                    colors={tones.bar}
                    start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                    style={{ flex: 1, borderRadius: 5, shadowColor: rgba(tones.acc, 0.3), shadowOpacity: 0.9, shadowRadius: 10 }}
                  />
                ) : (
                  <View style={{ flex: 1, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.18)' }} />
                )}
              </View>
            </Enter>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 3, paddingTop: 5 }}>
        {labels.map((l) => (
          <T key={l} style={{ flex: 1, textAlign: 'center', fontSize: 7.5, color: Dot(0.4) }}>{l}</T>
        ))}
      </View>
    </View>
  );
}

export function TodoRow({ done, children }: { done?: boolean; children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View
        style={[
          {
            width: 14, height: 14, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
            borderWidth: 1.4, borderColor: 'rgba(255,255,255,0.32)', overflow: 'hidden',
          },
          done && { borderColor: 'transparent', shadowColor: tones.glow(), shadowOpacity: 0.7, shadowRadius: 8 },
        ]}
      >
        {done && <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
        {done && <Icon name="check" size={8} color="#fff" />}
      </View>
      <T
        style={[{ fontSize: 9.8, color: Dot(0.78) }, done && { textDecorationLine: 'line-through', color: Dot(0.38) }]}
      >
        {children}
      </T>
    </View>
  );
}

export function ApprBtns({ onApprove, onDeny }: { onApprove?: () => void; onDeny?: () => void }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', gap: 7 }}>
      <PressScale scale={0.94} onPress={onApprove} accessibilityLabel="Approve" accessibilityRole="button">
        <View
          style={{
            height: 27, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6,
            overflow: 'hidden', shadowColor: tones.glow(), shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 5 },
          }}
        >
          <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
          <Icon name="check" size={11} color="#fff" />
          <T style={{ fontSize: 10, fontWeight: '600', color: '#fff' }}>Approve</T>
        </View>
      </PressScale>
      <PressScale scale={0.94} onPress={onDeny} accessibilityLabel="Deny" accessibilityRole="button">
        <View
          style={{
            height: 27, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6,
            backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
          }}
        >
          <Icon name="x" size={11} color="rgba(255,255,255,0.75)" />
          <T style={{ fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.75)' }}>Deny</T>
        </View>
      </PressScale>
    </View>
  );
}

export function Btn({
  variant = 'pri', icon, children, onPress,
}: { variant?: 'pri' | 'ghost'; icon?: IconName; children?: ReactNode; onPress?: () => void }) {
  const { tones } = useAccent();
  return (
    <PressScale scale={0.94} onPress={onPress}>
      <View
        style={{
          height: 27, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6,
          overflow: 'hidden',
          ...(variant === 'ghost'
            ? { backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }
            : { shadowColor: tones.glow(), shadowOpacity: 0.6, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }),
        }}
      >
        {variant === 'pri' && <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
        {icon ? <Icon name={icon} size={12} color={variant === 'pri' ? '#fff' : 'rgba(255,255,255,0.78)'} /> : null}
        <T style={{ fontSize: 10, fontWeight: '600', color: variant === 'pri' ? '#fff' : 'rgba(255,255,255,0.78)' }}>{children}</T>
      </View>
    </PressScale>
  );
}

/* --------------------------------- swatches --------------------------------- */

export function Swatch({ hex, on, onPress, size = 27, label }: { hex: string; on?: boolean; onPress?: () => void; size?: number; label?: string }) {
  const { tones, setAccent } = useAccent();
  const selected = on ?? tones.acc.toLowerCase() === hex.toLowerCase();
  return (
    <PressScale
      scale={0.88}
      accessibilityLabel={label ?? hex}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => (onPress ? onPress() : setAccent(hex))}
      style={{ width: size, height: size, borderRadius: 999, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: size, height: size, borderRadius: 999, backgroundColor: hex,
          borderWidth: 2, borderColor: selected ? '#fff' : 'rgba(255,255,255,0.22)',
          shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {selected && <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.55)' }} />}
      </View>
      {selected && <Halo color={tones.glow()} size={size * 2.4} strength={0.5} style={{ marginTop: -size * 1.7 }} />}
    </PressScale>
  );
}

/** The rainbow custom-skin chip — opens the hue sheet. */
export function CustomSwatch({ size = 27 }: { size?: number }) {
  const { accent } = useAccent();
  const [open, setOpen] = useState(false);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const cols = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#f43f5e'];
  return (
    <>
      <PressScale scale={0.88} onPress={() => setOpen(true)} style={{ width: size, height: size }} accessibilityLabel="Custom color" accessibilityRole="button">
        <View
          style={{
            width: size, height: size, borderRadius: 999, overflow: 'hidden',
            borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.30)',
            backgroundColor: '#000',
          }}
        >
          <Svg width={size} height={size}>
            <Defs>
              <RadialGradient id={`cw${id}`} cx="50%" cy="50%" r="60%">
                {cols.map((c, i) => (
                  <Stop key={i} offset={`${(i / (cols.length - 1)) * 100}%`} stopColor={c} />
                ))}
              </RadialGradient>
            </Defs>
            <Circle cx={size / 2} cy={size / 2} r={size / 2 - 2} fill={`url(#cw${id})`} />
          </Svg>
        </View>
      </PressScale>
      <HueSheet visible={open} onClose={() => setOpen(false)} initial={accent} />
    </>
  );
}

export function SwatchRow({ label = 'Skin', size = 27 }: { label?: string; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      <T style={{ fontSize: 10.5, color: Dot(0.42), letterSpacing: 0.4, marginRight: 2 }}>{label}</T>
      {PRESETS.map((p) => (
        <Swatch key={p.hex} hex={p.hex} size={size} label={p.name} />
      ))}
      <CustomSwatch size={size} />
    </View>
  );
}

/** Live hue picker — drag to re-skin the whole app. */
export function HueSheet({ visible, onClose, initial }: { visible: boolean; onClose: () => void; initial: string }) {
  const { setAccent } = useAccent();
  const [hue, setHue] = useState(() => hexToHue(initial));
  const [w, setW] = useState(240);
  const track = useMemo(() => ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#f43f5e'] as [string, ...string[]], []);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      const h = Math.max(0, Math.min(360, (e.x / w) * 360));
      setHue(h);
    })
    .runOnJS(true);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(5,1,0,0.6)', alignItems: 'center', justifyContent: 'center' }} onPress={onClose}>
        <PressScale onPressIn={() => {}} onPress={() => {}}>
          <GlassCard style={{ width: 280, padding: 14 }} glow>
            <T style={{ fontSize: 13, fontWeight: '700', color: '#fff', marginBottom: 3 }}>Custom skin</T>
            <T style={{ fontSize: 9.5, color: Dot(0.5), marginBottom: 14 }}>
              Drag anywhere on the spectrum — the whole app re-skins live.
            </T>
            <GestureDetector gesture={pan}>
              <View
                onLayout={(e) => setW(e.nativeEvent.layout.width)}
                style={{ paddingVertical: 14 }}
              >
                <View style={{ height: 18, borderRadius: 999, overflow: 'hidden' }}>
                  <LinearGradient colors={track as never} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
                </View>
                <View
                  style={{
                    position: 'absolute', top: 6, left: `${(hue / 360) * 100}%` as `${number}%`, marginLeft: -11,
                    width: 26, height: 26, borderRadius: 999, backgroundColor: '#fff',
                    alignItems: 'center', justifyContent: 'center',
                    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
                  }}
                >
                  <View style={{ width: 16, height: 16, borderRadius: 999, backgroundColor: hslToHex(hue) }} />
                </View>
              </View>
            </GestureDetector>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
              <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: hslToHex(hue), marginRight: 8, borderWidth: 2, borderColor: '#fff' }} />
              <T style={{ flex: 1, fontFamily: MONO, fontSize: 11, color: Dot(0.7) }}>{hslToHex(hue)}</T>
              <Btn onPress={() => { setAccent(hslToHex(hue)); onClose(); }}>Use this</Btn>
            </View>
          </GlassCard>
        </PressScale>
      </Pressable>
    </Modal>
  );
}

/* ------------------------------ misc helpers -------------------------------- */

export function Avatar({ size = 31, small }: { size?: number; small?: boolean }) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(13,5,2,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
        shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
      }}
    >
      <Icon name="logo" size={small ? 13 : 17} color="#fff" />
    </View>
  );
}

export function MicFab({ onPress }: { onPress?: () => void }) {
  const { tones } = useAccent();
  return (
    <PressScale scale={0.9} onPress={onPress} style={{ width: 38, height: 38 }}>
      <View style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center' }}>
        <Halo color={tones.glow()} size={70} strength={0.55} style={{ marginTop: -16, marginLeft: -16 }} />
        <LinearGradient
          colors={tones.bubble}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={{
            width: 38, height: 38, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
            shadowColor: '#fff', shadowOpacity: 0.4, shadowRadius: 1, shadowOffset: { width: 0, height: 1 },
          }}
        >
          <Icon name="mic" size={16} color="#fff" />
        </LinearGradient>
      </View>
    </PressScale>
  );
}

export function GreenRow({ children }: { children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 23 }}>
      <Icon name="checkc" size={13} color={GREEN} />
      <T style={{ fontSize: 9.5, color: Dot(0.7) }}>{children}</T>
    </View>
  );
}

export function UrlBar({ children }: { children?: ReactNode }) {
  return (
    <View
      style={{
        flex: 1, height: 22, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9,
      }}
    >
      <Icon name="lock" size={9} color="rgba(255,255,255,0.6)" />
      <T style={{ fontFamily: MONO, fontSize: 8.5, color: Dot(0.6) }} numberOfLines={1}>{children}</T>
    </View>
  );
}

export const BwDots = () => (
  <View style={{ flexDirection: 'row', gap: 4 }}>
    {[0, 1, 2].map((i) => (
      <View key={i} style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.25)' }} />
    ))}
  </View>
);

export function IGThumb({ on, bg, onPress, style }: { on?: boolean; bg: [string, string] | 'conic'; onPress?: () => void; style?: object }) {
  const { tones } = useAccent();
  return (
    <PressScale scale={0.95} onPress={onPress} style={[{ height: 74, borderRadius: 11, overflow: 'hidden', borderWidth: on ? 2 : 1, borderColor: on ? tones.acc : 'rgba(255,255,255,0.2)', position: 'relative' } as object, style as object]}>
      {bg === 'conic' ? (
        <LinearGradient colors={['#FFD9A6', '#C25508', '#3a1200', '#FFD9A6']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }} />
      ) : (
        <LinearGradient colors={bg} start={{ x: 0.2, y: 0.1 }} end={{ x: 0.9, y: 1 }} style={{ flex: 1 }} />
      )}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.10)' }} />
      {on && (
        <View style={{ position: 'absolute', top: 5, right: 5, width: 15, height: 15, borderRadius: 999, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
          <LinearGradient colors={tones.bubble} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
          <Icon name="check" size={8} color="#fff" />
        </View>
      )}
    </PressScale>
  );
}

export const Scroll = ({ children, style }: { children?: ReactNode; style?: object }) => (
  <ScrollView showsVerticalScrollIndicator={false} style={[{ flex: 1 } as object, style as object]} contentContainerStyle={{ paddingBottom: 8 }}>
    {children}
  </ScrollView>
);

/* re-export the motion primitives so screens can import everything from the kit */
export { Enter, stagger, PressScale, SPRING, Breathe, Pulse, Bob, Halo } from './motion';
