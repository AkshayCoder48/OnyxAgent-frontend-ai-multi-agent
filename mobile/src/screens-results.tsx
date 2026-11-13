/** Screens S15–S19 — “Tool results, made pretty” group. Design unit: 276×570. */
import React, { useState } from 'react';
import { Text as RT, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  BwDots, ChatBar, ChatHeader, Cites, Dot, Enter, FakeLine, GlassCard, GreenRow, IGThumb,
  MsgAI, MsgU, PageBlock, SrcRow, StateDot, UrlBar, WorkingLine, stagger, BarsChart, TodoRow,
} from './kit';
import { Icon } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';
import { GREEN } from './theme';

/* S15 · Web search results */
export function S15WebResults() {
  const srcs = [
    { fav: 'U', dm: 'docs.uniswap.org', t: 'Hook permissions & lifecycle', p: 'beforeSwap / afterSwap callbacks, dynamic fees and the singleton pool design…' },
    { fav: 'M', dm: 'mirror.xyz', t: 'Uniswap v4 hooks, explained visually', p: 'How hook-enabled pools differ from v3, with fee-tier diagrams…' },
    { fav: 'G', dm: 'github.com', t: 'v4-core · hook examples', p: 'Reference implementations: limit orders, TWAMM, volatility oracle…' },
  ];
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="ddg_search" role="web" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>What changed in Uniswap v4 hooks?</MsgU></Enter>
        <Enter delay={110}><MsgAI>Top results — I'll read the best two next:</MsgAI></Enter>
        {srcs.map((s, i) => (
          <Enter key={s.dm} delay={stagger(i, 130)} y={20}>
            <GlassCard>
              <SrcRow fav={s.fav} domain={s.dm} title={s.t} desc={s.p} />
            </GlassCard>
          </Enter>
        ))}
        <Enter delay={560}>
          <Cites nums={[1, 2, 3]} note="11 sources · 1.4s" />
        </Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

/* S16 · Web page reader */
export function S16Reader() {
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="web_fetch" role="reader" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgAI>Reading the docs page — 12 KB distilled:</MsgAI></Enter>
        <Enter delay={120} y={22}>
          <GlassCard>
            <SrcRow fav="U" domain="docs.uniswap.org · 6 min read" title="Hook permissions" />
            <View style={{ marginTop: 7, gap: 5 }}>
              <FakeLine w="92%" />
              <FakeLine w="98%" />
              <FakeLine w="88%" hl />
              <FakeLine w="95%" />
              <FakeLine w="74%" />
              <FakeLine w="90%" />
              <FakeLine w="64%" hl mg={0} />
            </View>
            <RT style={{ fontSize: 8.5, color: Dot(0.45), marginTop: 7, lineHeight: 13 }}>
              Highlighted: the line your bot cares about.
            </RT>
          </GlassCard>
        </Enter>
        <Enter delay={240}>
          <GreenRow>web_fetch done · 12.1 KB · 3 citations</GreenRow>
        </Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

/* S17 · Browser tool — live session */
export function S17Browser() {
  const { tones } = useAccent();
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="use_browser" role="live" rightIcon="x" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Grab the live TVL from the dashboard</MsgU></Enter>
        <Enter delay={110}><MsgAI>Driving a real browser session for you:</MsgAI></Enter>
        <Enter delay={190} y={22}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <BwDots />
              <UrlBar>defillama.com/protocol/uniswap-v4</UrlBar>
            </View>
            <View style={{ marginTop: 8 }}>
              <GlassCard style={{ padding: 9, backgroundColor: 'rgba(0,0,0,0.32)', gap: 6 }}>
                <PageBlock h={38} style={{ justifyContent: 'center', paddingHorizontal: 8 }}>
                  <RT style={{ fontSize: 9, fontWeight: '700', color: '#fff' }}>DefiLlama</RT>
                </PageBlock>
                <View style={{ height: 64, borderRadius: 7, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
                  <LinearGradient colors={['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.06)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
                  <RT style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>
                    $4.21B <RT style={{ fontSize: 8.5, fontWeight: 500, color: GREEN }}>▲ 2.4%</RT>
                  </RT>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <PageBlock h={26} style={{ flex: 1 }} />
                  <PageBlock h={26} style={{ flex: 1 }} />
                </View>
              </GlassCard>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8 }}>
              <Icon name="cursor" size={13} color="#fff" />
              <RT style={{ fontSize: 9, color: Dot(0.6) }}>
                clicking <RT style={{ color: tones.accXh, fontWeight: '700' }}>#tvl-stat</RT> …
              </RT>
              <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <RT style={{ fontSize: 9, color: Dot(0.55) }}>Session live</RT>
                <StateDot state="run" size={6} />
              </View>
            </View>
          </GlassCard>
        </Enter>
        <Enter delay={300}>
          <WorkingLine>web_session kept warm for follow-ups</WorkingLine>
        </Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

/* S18 · Image generation — pick a variant */
export function S18ImageGen() {
  const [sel, setSel] = useState(0);
  const { tones } = useAccent();
  const thumbs: Array<[string, string] | 'conic'> = [
    ['#FFDCAE', '#F07E12'],
    ['#FFE9C9', '#E8720C'],
    'conic',
    ['#FFC98A', '#B44E08'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="pollinations" role="image" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>4 options for the app's hero orb</MsgU></Enter>
        <Enter delay={120} y={22}>
          <GlassCard>
            <RT style={{ fontSize: 9, fontStyle: 'italic', color: Dot(0.55), lineHeight: 13 }}>
              "molten glass orb, warm orange glow, dark background, product hero"
            </RT>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 }}>
              {thumbs.map((tb, i) => (
                <View key={i} style={{ width: '48%' }}>
                  <IGThumb
                    on={sel === i}
                    bg={tb === 'conic' ? 'conic' : tb}
                    onPress={() => setSel(i)}
                    style={{ height: 74 }}
                  />
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 7, marginTop: 8 }}>
              <BtnPri label="Use this" icon="check" />
              <BtnGhost label="Regenerate" icon="redo" />
            </View>
          </GlassCard>
        </Enter>
        <Enter delay={260}>
          <GreenRow>
            preview_image · 1024² · <RT style={{ color: tones.accXh, fontWeight: '700' }}>saved to assets/orb.png</RT>
          </GreenRow>
        </Enter>
        <WorkingLine>Confirm before spending credits — enabled in Approvals</WorkingLine>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

function BtnPri({ label, icon }: { label: string; icon: Parameters<typeof Icon>[0]['name'] }) {
  const { tones } = useAccent();
  return (
    <PressScale scale={0.94}>
      <View
        style={{
          height: 27, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden',
          shadowColor: tones.glow(), shadowOpacity: 0.6, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
        }}
      >
        <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
        <Icon name={icon} size={12} color="#fff" />
        <RT style={{ fontSize: 10, fontWeight: '600', color: '#fff' }}>{label}</RT>
      </View>
    </PressScale>
  );
}
function BtnGhost({ label, icon }: { label: string; icon: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <PressScale scale={0.94}>
      <View
        style={{
          height: 27, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
        }}
      >
        <Icon name={icon} size={12} color="rgba(255,255,255,0.78)" />
        <RT style={{ fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.78)' }}>{label}</RT>
      </View>
    </PressScale>
  );
}

/* S19 · Charts & todos — live checkboxes */
export function S19Charts() {
  const [todos, setTodos] = useState([true, true, false, false]);
  const labels = ['Read design guidelines', 'Generate orb SVG set', 'Assemble widget shell', 'Audit + ship to workspace'];
  const { tones } = useAccent();
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="create_chart" role="todos" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Plot this week's pool volume and track the plan.</MsgU></Enter>
        <Enter delay={120} y={22}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="chart" size={12} color={tones.accXh} />
              </View>
              <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>Pool volume · $M</RT>
              <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <RT style={{ fontSize: 9, color: Dot(0.55) }}>Chart</RT>
                <StateDot state="done" size={6} />
              </View>
            </View>
            <View style={{ marginTop: 8 }}>
              <BarsChart data={[34, 52, 72, 46, 92, 64, 40]} labels={['M', 'T', 'W', 'T', 'F', 'S', 'S']} />
            </View>
          </GlassCard>
        </Enter>
        <Enter delay={220} y={22}>
          <GlassCard>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="listcheck" size={12} color={tones.accXh} />
              </View>
              <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>todos · widget build</RT>
              <RT style={{ marginLeft: 'auto', fontSize: 9, color: Dot(0.55) }}>{todos.filter(Boolean).length}/4</RT>
            </View>
            <View style={{ marginTop: 8, gap: 6 }}>
              {labels.map((l, i) => (
                <PressScale key={l} scale={0.98} onPress={() => setTodos((t) => t.map((v, j) => (j === i ? !v : v)))}>
                  <TodoRow done={todos[i]}>{l}</TodoRow>
                </PressScale>
              ))}
            </View>
          </GlassCard>
        </Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}
