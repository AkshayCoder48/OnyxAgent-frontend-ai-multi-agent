/** Screens S1–S4 — “Chat experience” group. Design unit: 276×570. */
import React, { useEffect, useRef, useState } from 'react';
import { Text as RT, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  Avatar, ChatBar, ChatHeader, Dot, Enter, GlassCard, HL, MicFab, MsgAI, MsgU,
  RateRow, SideItem, SideLabel, StateDot, stagger, ThinkLine, ToolBatch, WorkingLine,
} from './kit';
import { Icon } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';

/* S1 · Home — “What are we building today?” */
export function S1Home() {
  const { tones } = useAccent();
  const router = useRouter();
  const chips = ['Deploy autonomous agent', 'Optimize gas for ZK-proofs', 'Audit liquidity protocol'];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 16 }}>
        <PressScale onPress={() => router.push('/settings')} scale={0.96}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <Avatar size={31} />
            <View>
              <RT style={{ fontSize: 11.5, fontWeight: '600', color: '#fff' }}>Brohamian</RT>
            </View>
          </View>
        </PressScale>
      </View>

      <View style={{ paddingHorizontal: 16, marginTop: 44, marginBottom: 16 }}>
        <Enter delay={60} y={22} from={0.94}>
          <RT
            style={{
              fontSize: 26, lineHeight: 33, fontWeight: '600', color: '#fff', letterSpacing: -0.2,
              textShadowColor: tones.glow(0.35), textShadowRadius: 18,
            }}
          >
            What are we building today?
          </RT>
        </Enter>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, paddingLeft: 16 }}>
        {chips.map((c, i) => (
          <Enter key={c} delay={stagger(i, 90)} from={0.92}>
            <PressScale scale={0.95} onPress={() => router.push('/chat')}>
              <GlassCard style={{ width: 96, paddingVertical: 11, paddingHorizontal: 11, paddingBottom: 12 }}>
                <View style={{ height: 14, justifyContent: 'center' }}>
                  <Icon name="spark" size={14} color={tones.accXh} />
                </View>
                <RT style={{ fontSize: 11, lineHeight: 15, fontWeight: '500', color: '#fff' }}>{c}</RT>
              </GlassCard>
            </PressScale>
          </Enter>
        ))}
      </View>

      <View style={{ flex: 1 }} />
      <Enter delay={340} y={26} from={0.97}>
        <GlassCard style={{ marginHorizontal: 14, marginBottom: 14, borderRadius: 18, padding: 14, minHeight: 150 }}>
          <RT style={{ fontSize: 12, lineHeight: 18, color: Dot(0.5) }}>
            Ask AI a question or describe your idea
          </RT>
          <View style={{ marginTop: 'auto', flexDirection: 'row', alignItems: 'center', gap: 9, paddingTop: 12 }}>
            <PressScale scale={0.92}>
              <View
                style={{
                  width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
                  borderTopColor: 'rgba(255,255,255,0.24)',
                }}
              >
                <Icon name="clip" size={15} color="rgba(255,255,255,0.7)" />
              </View>
            </PressScale>
            <PressScale scale={0.95} onPress={() => router.push('/chat')}>
              <View
                style={{
                  height: 31, paddingHorizontal: 11, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 4,
                  backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
                  borderTopColor: 'rgba(255,255,255,0.22)',
                }}
              >
                <RT style={{ fontSize: 11, fontWeight: 500, color: '#fff' }}>Opus 4.8</RT>
                <Icon name="chev" size={11} color="rgba(255,255,255,0.7)" />
              </View>
            </PressScale>
            <View style={{ flex: 1 }} />
            <MicFab onPress={() => router.push('/chat')} />
          </View>
        </GlassCard>
      </Enter>
    </View>
  );
}

/* S2 · Chat with tools — collapsed batch card */
export function S2ChatTools() {
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="Opus 4.8" role="Agent" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Make an AI agent chat app</MsgU></Enter>
        <Enter delay={120}>
          <MsgAI>I'll build an interactive agent chat widget. Let me check the design guidelines first.</MsgAI>
        </Enter>
        <Enter delay={200} y={22}>
          <ToolBatch
            chips={[
              { t: 'read_file', d: 'done' as const },
              { t: 'ddg_search', d: 'done' as const },
              { t: 'run_python', d: 'done' as const },
              { t: 'create_file', d: 'run' as const },
              { t: 'preview_image', d: 'idle' as const },
              { t: 'web_fetch', d: 'idle' as const },
              { t: 'spawn_subagent', d: 'idle' as const },
              { t: 'create_chart', d: 'idle' as const },
              { t: 'memory', d: 'idle' as const },
              { t: 'todos', d: 'idle' as const },
            ]}
            out={<>Provide <HL>SVG code</HL> for the chat orb, then assemble the widget shell…</>}
          />
        </Enter>
        <Enter delay={300}><ThinkLine>Thinking complete · 4s</ThinkLine></Enter>
      </View>
      <ChatBar placeholder="Ask anything. Images work too…" />
    </View>
  );
}

/* S3 · Chat — live thread: tap send, watch Ara work. */
export function S3Chat() {
  type Extra = { who: 'u' | 'ai' };
  const [extra, setExtra] = useState<Extra[]>([]);
  const [phase, setPhase] = useState<'idle' | 'working'>('idle');
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const send = () => {
    if (phase === 'working') return;
    setExtra((m) => [...m, { who: 'u' }]);
    setPhase('working');
    timers.current.push(
      setTimeout(() => {
        setExtra((m) => [...m, { who: 'ai' }]);
        setPhase('idle');
      }, 1400),
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="Opus 4.8" role="Agent" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Deploy an autonomous AI agent to monitor liquidity pools</MsgU></Enter>
        <Enter delay={120}>
          <MsgAI>
            Deployed <HL>AlphaRaptor.sh</HL> to your agent network. The automation loop is active. Need to configure risk mitigation parameters?
          </MsgAI>
        </Enter>
        <Enter delay={200}><RateRow /></Enter>
        {extra.map((m, i) => (
          <Enter key={i} delay={40}>
            {m.who === 'u'
              ? <MsgU>Show me the active core parameters.</MsgU>
              : <MsgAI>Core agent parameters initialized.</MsgAI>}
          </Enter>
        ))}
        {phase === 'working' && (
          <Enter>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 23 }}>
              <StateDot state="run" size={6} />
              <WorkingLine>Ara is working…</WorkingLine>
            </View>
          </Enter>
        )}
      </View>
      <View style={{ marginHorizontal: 12, marginTop: 12, marginBottom: 13 }}>
        <PressScale scale={0.98} onPress={send}>
          <GlassCard style={{ borderRadius: 16, minHeight: 41, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 15 }}>
            <Icon name="clip" size={15} color="rgba(255,255,255,0.7)" />
            <RT style={{ flex: 1, fontSize: 11.5, color: Dot(0.5) }}>
              Ask AI a question — tap to send
            </RT>
            <Icon name="send" size={15} color="rgba(255,255,255,0.58)" />
          </GlassCard>
        </PressScale>
      </View>
    </View>
  );
}

/* S4 · Chat history drawer — the glass sidebar over the thread */
export function S4Sidebar() {
  return (
    <View style={{ flex: 1, position: 'relative' }}>
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }} pointerEvents="none">
        <MsgU>Audit liquidity protocol for exploits</MsgU>
        <MsgAI>Scan complete. No exploits found in v2 pools.</MsgAI>
        <MsgU>Tighten the slippage guard.</MsgU>
      </View>
      <ChatBar placeholder="Ask AI a question" />
      <View
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '66%',
          paddingHorizontal: 10, paddingBottom: 12,
        }}
      >
        <GlassSidebar />
      </View>
    </View>
  );
}

/** The drawer rail — shared by the S4 clone and the real app drawer. */
export function GlassSidebar({ onNavigate }: { onNavigate?: (route: string) => void }) {
  const { tones } = useAccent();
  const router = useRouter();
  const go = (r: string) => (onNavigate ? onNavigate(r) : router.push(r as never));
  return (
    <View style={{ flex: 1, borderRadius: 0, overflow: 'hidden', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.16)' }}>
      <BlurView intensity={30} tint="dark" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(30,13,4,0.34)' }} />
      <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 8 }}>
        <View
          style={{
            height: 34, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11,
            backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
            borderTopColor: 'rgba(255,255,255,0.28)',
          }}
        >
          <Icon name="search" size={13} color={Dot(0.5)} />
          <RT style={{ fontSize: 10.5, color: Dot(0.85) }}>Search all chats</RT>
        </View>

        <PressScale scale={0.97} onPress={() => go('/')} style={{ borderRadius: 12 }}>
          <View
            style={{
              height: 34, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, overflow: 'hidden',
              shadowColor: tones.glow(), shadowOpacity: 0.7, shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
            }}
          >
            <LinearGradient colors={tones.bubble} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
            <Icon name="plus" size={14} color="#fff" />
            <RT style={{ fontSize: 11, fontWeight: '600', color: '#fff' }}>New chat</RT>
          </View>
        </PressScale>

        <SideLabel>Recent</SideLabel>
        <SideItem icon="chat" title="Deploy agent network" time="2m" on onPress={() => go('/chat')} />
        <SideItem icon="chat" title="Audit liquidity" time="1h" onPress={() => go('/chat')} />
        <SideItem icon="chat" title="ZK-proof gas audit" time="5h" onPress={() => go('/chat')} />
        <SideLabel>Subagents</SideLabel>
        <SideItem icon="bot" title="@researcher" time="live" onPress={() => go('/subagent-chat')} />
        <SideItem icon="bot" title="@coder" time="1d" onPress={() => go('/subagent-chat')} />
        <View style={{ flex: 1 }} />
        <PressScale scale={0.98} onPress={() => go('/settings')} style={{ borderRadius: 12 }}>
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 12,
              backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
            }}
          >
            <Avatar size={26} small />
            <View style={{ flex: 1 }}>
              <RT style={{ fontSize: 10, fontWeight: '600', color: '#fff' }}>Brohamian</RT>
              <RT style={{ fontSize: 9, color: Dot(0.5) }}>Pro plan</RT>
            </View>
            <Icon name="gear" size={14} color={Dot(0.55)} />
          </View>
        </PressScale>
      </View>
    </View>
  );
}
