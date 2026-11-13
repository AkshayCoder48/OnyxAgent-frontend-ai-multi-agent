/** Screens S5–S8 — “Onboarding & input” group. Design unit: 276×570. */
import React, { useState, type ReactNode } from 'react';
import { Text as RT, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  ChatBar, ChatHeader, DiffLine, Dim, Dot, Enter, GlassCard, MsgAI, MsgU, OKS, Orb, SL, StHead,
  StateDot, STR, stagger,
} from './kit';
import { Icon, type IconName } from './icons';
import { Breathe, Halo, PressScale } from './motion';
import { useAccent } from './accent';
import { rgba } from './theme';

/* S5 · Onboarding */
export function S5Onboarding() {
  const { tones } = useAccent();
  const router = useRouter();
  const feats: Array<[IconName, string, string]> = [
    ['zap', '50+ built-in tools', 'Python, web search, files, charts, MCP'],
    ['bot', 'Subagents', 'The AI spawns researchers & coders for you'],
    ['lock', 'Frontend-only', 'Your keys & data never leave the device'],
  ];
  return (
    <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 12, alignItems: 'center' }}>
      <Enter delay={0} y={30} from={0.9}>
        <View style={{ alignItems: 'center', width: 76, height: 76 }}>
          <Halo color={tones.glow(0.55)} size={150} strength={0.5} style={{ top: -37, left: -37 }} />
          <Breathe>
            <Orb size={76} glow={false} />
          </Breathe>
        </View>
      </Enter>
      <Enter delay={80}>
        <RT style={{ fontSize: 20, fontWeight: '700', color: '#fff', letterSpacing: -0.3, marginTop: 12 }}>Meet OnyxAgent</RT>
      </Enter>
      <Enter delay={140}>
        <RT style={{ fontSize: 11, color: Dot(0.55), lineHeight: 16.5, marginTop: 5, textAlign: 'center' }}>
          50+ tools, subagent orchestration and streaming — all in one chat, stored on-device.
        </RT>
      </Enter>
      <View style={{ alignSelf: 'stretch', gap: 7, marginVertical: 12 }}>
        {feats.map(([ic, b, s], i) => (
          <Enter key={b} delay={stagger(i, 110)}>
            <GlassCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 11 }}>
                <Icon name={ic} size={17} color={tones.accXh} />
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 11, color: '#fff', fontWeight: '600' }}>{b}</RT>
                  <RT style={{ fontSize: 9.5, color: Dot(0.5) }}>{s}</RT>
                </View>
              </View>
            </GlassCard>
          </Enter>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <Enter delay={520} from={0.95} style={{ alignSelf: 'stretch' }}>
        <PressScale scale={0.97} onPress={() => router.push('/')} style={{ alignSelf: 'stretch' }}>
          <View
            style={{
              height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, overflow: 'hidden',
              shadowColor: tones.glow(), shadowOpacity: 0.75, shadowRadius: 26, shadowOffset: { width: 0, height: 10 },
            }}
          >
            <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
            <RT style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Get started</RT>
            <Icon name="chevr" size={15} color="#fff" />
          </View>
        </PressScale>
      </Enter>
      <PressScale onPress={() => router.push('/settings')}>
        <RT style={{ fontSize: 10.5, color: Dot(0.45), textAlign: 'center', marginTop: 9 }}>I already have an API key</RT>
      </PressScale>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 10, alignItems: 'center' }}>
        <View style={{ width: 17, height: 6, borderRadius: 999, overflow: 'hidden' }}>
          <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }} />
        </View>
        <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.22)' }} />
        <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.22)' }} />
      </View>
    </View>
  );
}

/* S6 · Expanded tool run — iPython request/response cards */
export function S6IPython() {
  const { tones } = useAccent();
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="Opus 4.8" role="iPython" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Trim the widget bundle — what's in content?</MsgU></Enter>
        <Enter delay={110}><MsgAI>Running it through the sandbox:</MsgAI></Enter>
        <Enter delay={190} y={20}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
              <RT style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: Dot(0.5) }}>Request</RT>
              <RT style={{ fontSize: 8, color: Dot(0.35) }}>py</RT>
              <View style={{ marginLeft: 'auto' }}>
                <PressScale scale={0.85}><Icon name="copy" size={11} color={Dot(0.45)} /></PressScale>
              </View>
            </View>
            <CodeBg>
              <Dim>print</Dim>(len(content)){`\n`}
              <Dim>print</Dim>(content[<STR>10000</STR>]:)
            </CodeBg>
          </GlassCard>
        </Enter>
        <Enter delay={270} y={20}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
              <RT style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: Dot(0.5) }}>Response</RT>
              <View style={{ marginLeft: 'auto' }}>
                <PressScale scale={0.85}><Icon name="copy" size={11} color={Dot(0.45)} /></PressScale>
              </View>
            </View>
            <CodeBg>
              <STR>28471</STR>{`\n`}
              <OKS>✓</OKS> useful content appears early:{`\n`}
              <Dim>1.</Dim> {'<style>'} + static HTML first{`\n`}
              <Dim>2.</Dim> inline local data{`\n`}
              <Dim>3.</Dim> {'<script>'} last
            </CodeBg>
          </GlassCard>
        </Enter>
        <Enter delay={350} y={20}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="code" size={12} color={tones.accXh} />
              </View>
              <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>edit_file · widget.tsx</RT>
              <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <RT style={{ fontSize: 9, color: Dot(0.55) }}>Done</RT>
                <StateDot state="done" size={6} />
              </View>
            </View>
            <View style={{ marginTop: 7, gap: 3 }}>
              <DiffLine kind="rem">- import {'{ Chart }'} from "charts"</DiffLine>
              <DiffLine kind="add">+ import {'{ Spark }'} from "./spark"</DiffLine>
            </View>
          </GlassCard>
        </Enter>
        <Enter delay={430}>
          <RT style={{ marginLeft: 23, fontSize: 10, color: Dot(0.42) }}>Bundle 28.4 KB → 11.2 KB</RT>
        </Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

/* S7 · Search all chats */
export function S7Search() {
  const { tones } = useAccent();
  const router = useRouter();
  const results: Array<{ ic: IconName; t: string; snip: ReactNode; time: string }> = [
    { ic: 'chat', t: 'Deploy agent network', time: '2m', snip: <>…set the <Mark>liquidity guard</Mark> to 0.8% and rebalance every 6h…</> },
    { ic: 'bot', t: '@researcher · risk report', time: '1h', snip: <>the <Mark>liquidity guard</Mark> should trail volatility by ±12 bps…</> },
    { ic: 'file', t: 'risk-params.md', time: '5h', snip: <>slippage / <Mark>liquidity guard</Mark> / circuit breaker — live values…</> },
    { ic: 'chat', t: 'Tactical trading bot', time: '1d', snip: <>…tighten the <Mark>liquidity guard</Mark> before the NY open…</> },
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Search" sub="All chats, subagents & files" onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 14 }}>
        <Enter delay={60} from={0.95}>
          <View
            style={{
              marginTop: 6, height: 38, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12,
              backgroundColor: 'rgba(0,0,0,0.38)', borderWidth: 1, borderColor: rgba(tones.acc, 0.45),
              shadowColor: tones.glow(), shadowOpacity: 0.9, shadowRadius: 3, shadowOffset: { width: 0, height: 0 },
            }}
          >
            <Icon name="search" size={14} color={tones.accXh} />
            <RT style={{ fontStyle: 'italic', fontSize: 11.5, color: Dot(0.85) }}>liquidity guard</RT>
            <View style={{ flex: 1 }} />
            <Icon name="x" size={13} color={Dot(0.5)} />
          </View>
        </Enter>
      </View>
      <View style={{ flex: 1, flexDirection: 'column', gap: 8, paddingHorizontal: 14, paddingTop: 14 }}>
        {results.map((r, i) => (
          <Enter key={r.t} delay={stagger(i, 110)} y={18}>
            <GlassCard>
              <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-start', paddingVertical: 10, paddingHorizontal: 11 }}>
                <View style={{ marginTop: 1 }}>
                  <Icon name={r.ic} size={14} color={Dot(0.4)} />
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 10.5, color: Dot(0.9), fontWeight: '600' }} numberOfLines={1}>{r.t}</RT>
                  <RT style={{ fontSize: 9.5, color: Dot(0.5), lineHeight: 14, marginTop: 2 }} numberOfLines={2}>{r.snip}</RT>
                </View>
                <RT style={{ fontSize: 8.5, color: Dot(0.35) }}>{r.time}</RT>
              </View>
            </GlassCard>
          </Enter>
        ))}
      </View>
    </View>
  );
}

/* S8 · Slash command palette — tap a row, the composer follows */
export function S8Slash() {
  const [sel, setSel] = useState(0);
  const { tones } = useAccent();
  const cmds: Array<[IconName, string, string]> = [
    ['term', '/code', 'Run python in sandbox'],
    ['img', '/image', 'Generate with pollinations'],
    ['bot', '/agent', 'Spawn a subagent'],
    ['layers', '/skill', 'Install from marketplace'],
    ['db', '/kb', 'Search knowledge base'],
  ];
  const active = cmds[sel][1];
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="Opus 4.8" role="Agent" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <View style={{ opacity: 0.4, gap: 12 }}>
          <MsgU>Build the dashboard next</MsgU>
          <MsgAI>On it — spinning up the layout scaffold.</MsgAI>
        </View>
        <Enter delay={80} y={26} from={0.95}>
          <GlassCard style={{ width: '88%', alignSelf: 'center', padding: 8, gap: 4 }}>
            <RT style={{ fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.9, color: Dot(0.38), paddingHorizontal: 8, paddingTop: 2, paddingBottom: 4 }}>
              Slash commands
            </RT>
            {cmds.map(([i2, l, h], idx) => {
              const on = idx === sel;
              return (
                <PressScale key={l} scale={0.97} onPress={() => setSel(idx)} style={{ borderRadius: 11 }}>
                  <View
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 11,
                      backgroundColor: on ? 'rgba(255,255,255,0.12)' : 'transparent',
                      borderWidth: 1, borderColor: on ? 'rgba(255,255,255,0.14)' : 'transparent',
                    }}
                  >
                    <Icon name={i2} size={14} color={tones.accXh} />
                    <View style={{ flex: 1 }}>
                      <RT style={{ fontSize: 10.5, color: Dot(0.8) }}>
                        <RT style={{ fontFamily: 'monospace', fontSize: 10.5, fontWeight: 600, color: Dot(0.92) }}>{l}</RT>
                        {'  '}<RT style={{ fontSize: 9, color: Dot(0.42) }}>{h}</RT>
                      </RT>
                    </View>
                    {on && (
                      <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
                        <RT style={{ fontSize: 8.5, color: Dot(0.4) }}>↵</RT>
                      </View>
                    )}
                  </View>
                </PressScale>
              );
            })}
          </GlassCard>
        </Enter>
      </View>
      <ChatBar placeholder={active} tail="mic" />
    </View>
  );
}

/* ------------------------------- local helpers ------------------------------ */

function Mark({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return <RT style={{ color: tones.accXh, fontWeight: '600' }}>{children}</RT>;
}

function CodeBg({ children }: { children?: ReactNode }) {
  const { tones } = useAccent();
  return (
    <View
      style={{
        borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
        paddingHorizontal: 9, paddingVertical: 7,
      }}
    >
      <RT style={{ fontFamily: 'monospace', fontSize: 8.8, lineHeight: 15, color: tones.codeStr }}>{children}</RT>
    </View>
  );
}
