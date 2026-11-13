/** Screens S9–S11 — “Subagent orchestration” group. Design unit: 276×570. */
import React from 'react';
import { Text as RT, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Badge, ChatBar, ChatHeader, Dot, Enter, GlassCard, HL, MEN, MsgAI, MsgU, PBar,
  RateRow, Scroll, SL, StFoot, StHead, StateDot, stagger,
} from './kit';
import { Icon, type IconName } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';

/* S9 · Orchestrator — three subagents in flight */
export function S9Orchestrator() {
  const { tones } = useAccent();
  const subs: Array<{
    ic: IconName; name: string; tools: string; state: string; stateKind: 'run' | 'queued';
    w: number; out: React.ReactNode;
  }> = [
    {
      ic: 'search', name: 'Researcher', tools: 'ddg_search · web_fetch · rag', state: 'Working', stateKind: 'run', w: 72,
      out: <>Scanning 4 DEX auditors · <HL>11 sources</HL> so far</>,
    },
    {
      ic: 'code', name: 'Coder', tools: 'run_python · edit_file · e2b', state: 'Patching', stateKind: 'run', w: 38,
      out: <>+ slippage guard in <HL>bot.ts</HL> · tests queued</>,
    },
    {
      ic: 'shield', name: 'Analyst', tools: 'security_audit · counterfactual', state: 'Queued', stateKind: 'queued', w: 0,
      out: <>Waits for the patch, then runs <HL>security_audit</HL></>,
    },
  ];
  return (
    <View style={{ flex: 1 }}>
      <ChatHeader model="Opus 4.8" role="Orchestrator" rightIcon="bot" />
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}><MsgU>Research liquidity exploits, patch the bot, then audit it.</MsgU></Enter>
        <Enter delay={110}>
          <MsgAI>Splitting this across <HL>3 subagents</HL> — they share my sandbox and tools.</MsgAI>
        </Enter>
        {subs.map((s, i) => (
          <Enter key={s.name} delay={stagger(i, 150)} y={22}>
            <GlassCard>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={s.ic} size={13} color={tones.accXh} />
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>{s.name}</RT>
                  <RT style={{ fontSize: 8.5, color: Dot(0.45) }}>{s.tools}</RT>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <RT style={{ fontSize: 9, color: Dot(0.55) }}>{s.state}</RT>
                  <StateDot state={s.stateKind} size={6} />
                </View>
              </View>
              {s.w > 0 && <View style={{ marginTop: 7 }}><PBar w={s.w} /></View>}
              <View
                style={{
                  marginTop: 7, borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
                  paddingHorizontal: 8, paddingVertical: 5,
                }}
              >
                <RT style={{ fontSize: 9.5, lineHeight: 15, color: Dot(0.72) }}>{s.out}</RT>
              </View>
            </GlassCard>
          </Enter>
        ))}
        <Enter delay={560}>
          <RT style={{ marginLeft: 23, fontSize: 10, color: Dot(0.42) }}>3 subagents active · shared sandbox</RT>
        </Enter>
      </View>
      <ChatBar placeholder="Message the orchestrator…" />
    </View>
  );
}

/* S10 · Subagent chat with @mention */
export function S10SubagentChat() {
  const { tones } = useAccent();
  const rows: Array<[string, string]> = [
    ['@researcher', '· researching · 11 sources'],
    ['@coder', '· patching bot.ts'],
    ['@analyst', '· queued'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 4 }}>
        <ChatHeaderSide leftIcon="panel" pill={{ icon: 'bot', b: 'researcher', sep: '·', after: 'subagent' }} rightIcon="bm" />
      </View>
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }}>
        <Enter delay={40}>
          <MsgU><MEN>@researcher</MEN> findings so far?</MsgU>
        </Enter>
        <Enter delay={120}>
          <MsgAI>
            Found <HL>3 weak spots</HL> in v2 pools. Two are low-severity. One is interesting — oracle drift on the ETH/tok pair.
          </MsgAI>
        </Enter>
        <Enter delay={200}><RateRow /></Enter>
      </View>
      <Enter delay={280} y={24}>
        <GlassCard style={{ marginHorizontal: 14, marginTop: 8, padding: 7 }}>
          <RT style={{ fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.9, color: Dot(0.38), paddingHorizontal: 8, paddingTop: 2, paddingBottom: 4 }}>
            Mention a subagent
          </RT>
          {rows.map(([n, s], i) => {
            const on = i === 0;
            return (
              <PressScale key={n} scale={0.98} onPress={() => {}} style={{ borderRadius: 10 }}>
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 10,
                    backgroundColor: on ? 'rgba(255,255,255,0.13)' : 'transparent',
                    borderWidth: 1, borderColor: on ? 'rgba(255,255,255,0.14)' : 'transparent',
                  }}
                >
                  <Icon name="bot" size={13} color={tones.accXh} />
                  <RT style={{ fontSize: 10.5, color: Dot(0.78) }}>
                    {n} <RT style={{ fontSize: 9, color: Dot(0.4) }}>{s}</RT>
                  </RT>
                </View>
              </PressScale>
            );
          })}
        </GlassCard>
      </Enter>
      <View style={{ marginHorizontal: 12, marginTop: 12, marginBottom: 13 }}>
        <GlassCard style={{ borderRadius: 16, minHeight: 41, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 15 }}>
          <Icon name="at" size={15} color="rgba(255,255,255,0.58)" />
          <RT style={{ flex: 1, fontSize: 11.5, color: Dot(0.5) }}>@coder ship it when tests pass</RT>
          <Icon name="send" size={15} color="rgba(255,255,255,0.58)" />
        </GlassCard>
      </View>
    </View>
  );
}

function ChatHeaderSide({ leftIcon, pill, rightIcon }: { leftIcon: IconName; pill: { icon: IconName; b: string; sep: string; after: string }; rightIcon: IconName }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
      <HeaderGhost icon={leftIcon} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <View
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5, height: 27, paddingHorizontal: 12, borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
            borderTopColor: 'rgba(255,255,255,0.26)',
          }}
        >
          <Icon name={pill.icon} size={12} color="rgba(255,255,255,0.9)" />
          <RT style={{ fontSize: 10.5, fontWeight: '600', color: '#fff' }}>{pill.b}</RT>
          <RT style={{ fontSize: 10.5, color: Dot(0.45) }}>{pill.sep}</RT>
          <RT style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.92)' }}>{pill.after}</RT>
        </View>
      </View>
      <HeaderGhost icon={rightIcon} size={14} />
    </View>
  );
}

function HeaderGhost({ icon, size = 15 }: { icon: IconName; size?: number }) {
  return (
    <PressScale onPress={() => {}} style={{ width: 30, height: 30 }}>
      <View
        style={{
          width: 30, height: 30, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
          borderTopColor: 'rgba(255,255,255,0.26)',
        }}
      >
        <Icon name={icon} size={size} color="rgba(255,255,255,0.9)" />
      </View>
    </PressScale>
  );
}

/* S11 · Subagent settings */
export function S11Subagents() {
  const { tones } = useAccent();
  const router = useRouter();
  const rows: Array<[IconName, string, string, 'run' | 'queued']> = [
    ['search', 'Researcher', 'gpt-5.2 · ddg_search, web_fetch, rag', 'run'],
    ['code', 'Coder', 'claude-opus-4.8 · run_python, edit_file', 'run'],
    ['shield', 'Analyst', 'local:qwen3 · security_audit', 'queued'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Subagents" sub="Provider, model & prompt per agent" onBack={() => router.back()} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SL>Active</SL>
          {rows.map(([ic, b, s, st], i) => (
            <Enter key={b} delay={stagger(i, 90)}>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 13,
                  backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
                }}
              >
                <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={ic} size={14} color={tones.accXh} />
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{b}</RT>
                  <RT style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>{s}</RT>
                </View>
                <StateDot state={st} size={6} />
              </View>
            </Enter>
          ))}
          <SL>System prompt · researcher</SL>
          <Enter delay={80}>
            <GlassCard style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
              <RT style={{ fontFamily: 'monospace', fontSize: 8.6, lineHeight: 14, color: Dot(0.72) }}>
                <RT style={{ color: Dot(0.34) }}>You are</RT> a diligent web researcher.{`\n`}
                Always <RT style={{ color: '#8FE3AE' }}>cite sources</RT> and prefer{`\n`}
                primary docs over blogs…
              </RT>
            </GlassCard>
          </Enter>
          <Enter delay={140}>
            <PressScale scale={0.98} onPress={() => {}} style={{ marginTop: 4 }}>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 13,
                  borderStyle: 'dashed', borderWidth: 1.4, borderColor: 'rgba(255,255,255,0.24)', backgroundColor: 'rgba(255,255,255,0.03)',
                }}
              >
                <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="plus" size={14} color={tones.accXh} />
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.75) }}>Spawn new subagent</RT>
                  <RT style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>create_custom_tool also available</RT>
                </View>
              </View>
            </PressScale>
          </Enter>
          <StFoot>Chats survive refresh · pin & rename anytime</StFoot>
        </View>
      </Scroll>
    </View>
  );
}
