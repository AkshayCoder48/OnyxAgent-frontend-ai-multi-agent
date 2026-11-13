/** Screens S23–S27 — “Settings” group. Design unit: 276×570. */
import React, { useState } from 'react';
import { Text as RT, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  ApprBtns, Avatar, Badge, Dot, Enter, Field, GlassCard, GreenRow, MsgAI, Orb, PBar,
  Row, Scroll, Seg, SL, StFoot, StHead, SwatchRow, Toggle, stagger, StateDot,
} from './kit';
import { Icon, type IconName } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';
import { GREEN, WARN, PRESETS } from './theme';

/* S23 · Settings home */
export function S23Settings() {
  const router = useRouter();
  const [approvals, setApprovals] = useState(true);
  const rows: Array<{ sl: string; items: Array<{ ic: IconName; b: string; s: string; end?: React.ReactNode; to?: string; badge?: 'grn' | 'dim' | 'acc'; badgeText?: string }> }> = [
    {
      sl: 'Model & agents',
      items: [
        { ic: 'key', b: 'AI providers', s: 'OpenAI-compatible · per-chat model', to: '/providers' },
        { ic: 'bot', b: 'Subagents', s: 'provider, model & prompt each', to: '/subagents', badge: 'acc', badgeText: '3' },
        { ic: 'pen', b: 'System prompt', s: 'editor · variables & presets', to: '/providers' },
      ],
    },
    {
      sl: 'Extend',
      items: [
        { ic: 'layers', b: 'Skills', s: 'marketplace + custom uploads', to: '/skills' },
        { ic: 'plug', b: 'MCP servers', s: '3 connected · 14 tools', to: '/mcp' },
        { ic: 'zap', b: 'Custom tools', s: 'HTTP webhooks · python snippets', to: '/custom-tools' },
        { ic: 'term', b: 'Slash commands', s: 'built-ins + your shortcuts', to: '/custom-tools' },
      ],
    },
    {
      sl: 'App',
      items: [
        { ic: 'sun', b: 'Appearance', s: 'brand color · 50 schemes · theme', to: '/appearance', badge: 'acc', badgeText: 'Try it' },
        { ic: 'cal', b: 'Schedules', s: 'run agents on a calendar', to: '/automation', badge: 'dim', badgeText: '2' },
        { ic: 'lock', b: 'Environment variables', s: 'secrets injected into sandbox', to: '/automation' },
        { ic: 'img', b: 'The clone suite', s: 'all 27 screens · both showcases', to: '/gallery', badge: 'acc', badgeText: '27' },
      ],
    },
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead
        title="Settings"
        sub="Everything on-device · BYOK"
        right={
          <View style={{ width: 28, height: 28, borderRadius: 999, backgroundColor: 'rgba(13,5,2,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="logo" size={13} color="#fff" />
          </View>
        }
      />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          {rows.map((g, gi) => (
            <View key={g.sl}>
              <SL>{g.sl}</SL>
              {g.items.map((it, i) => (
                <Enter key={it.b} delay={stagger(i, 60, 400) + gi * 40}>
                  <Row
                    icon={it.ic}
                    title={it.b}
                    sub={it.s}
                    onPress={it.to ? () => router.push(it.to as never) : undefined}
                    end={
                      <>
                        {it.badge && <Badge variant={it.badge}>{it.badgeText}</Badge>}
                        {it.b === 'Approvals' ? null : <Icon name="chevr" size={12} color={Dot(0.3)} />}
                      </>
                    }
                  />
                </Enter>
              ))}
            </View>
          ))}
          <StFoot>OnyxAgent v2.4.0 · MIT · vault-encrypted keys</StFoot>
        </View>
      </Scroll>
    </View>
  );
}

/* S24 · Appearance — the working color picker */
export function S24Appearance() {
  const router = useRouter();
  const { tones, setAccent, accent } = useAccent();
  const [theme, setTheme] = useState(0);
  const schemes: Array<[string, string, string]> = [
    ['#FBA03F', '#E8720C', 'Black and Orange'],
    ['#34d399', '#059669', 'Emerald'],
    ['#60a5fa', '#2563eb', 'Ocean Blue'],
    ['#f472b6', '#db2777', 'Rose Pink'],
    ['#fbbf24', '#d97706', 'Sunset Gold'],
    ['#a78bfa', '#7c3aed', 'Midnight Purple'],
    ['#94a3b8', '#1e293b', 'Carbon Black'],
    ['#5eead4', '#0f766e', 'Deep Space'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Appearance" sub="Brand color & 50 schemes" onBack={() => router.back()} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SL>Brand color — changes the live app</SL>
          <Enter delay={60}>
            <GlassCard style={{ gap: 8 }}>
              <SwatchRow />
              <RT style={{ fontSize: 8.5, color: Dot(0.4), lineHeight: 12 }}>
                Default is <RT style={{ color: tones.accXh, fontWeight: '600' }}>orange</RT> — pick any color and every screen re-skins instantly. Your choice is saved.
              </RT>
            </GlassCard>
          </Enter>
          <SL>Theme</SL>
          <Enter delay={120}>
            <Seg
              options={[{ icon: 'moon' as IconName, label: 'Dark' }, { icon: 'sun' as IconName, label: 'Light' }]}
              value={theme}
              onChange={setTheme}
            />
          </Enter>
          <SL>Color schemes · 30 light / 20 dark</SL>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
            {schemes.map(([a, b, name], i) => {
              const on = accent.toLowerCase() === a.toLowerCase();
              return (
                <Enter key={name} delay={stagger(i, 40, 320)}>
                  <PressScale scale={0.92} onPress={() => setAccent(a)}>
                    <View
                      style={{
                        width: 57, height: 24, borderRadius: 8, overflow: 'hidden',
                        borderWidth: on ? 2 : 1, borderColor: on ? '#fff' : 'rgba(255,255,255,0.16)',
                        ...(on ? { shadowColor: tones.glow(), shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } } : {}),
                      }}
                    >
                      <LinearGradient colors={[a, b]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1 }} />
                    </View>
                  </PressScale>
                </Enter>
              );
            })}
          </View>
          <SL>Preview</SL>
          <Enter delay={380}>
            <GlassCard style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <Orb size={22} />
              <RT style={{ fontSize: 10, color: Dot(0.8) }}>Bubbles, glows & charts follow the brand color</RT>
            </GlassCard>
          </Enter>
        </View>
      </Scroll>
    </View>
  );
}

/* S25 · AI providers */
export function S25Providers() {
  const router = useRouter();
  const { tones } = useAccent();
  const [opus, setOpus] = useState(true);
  const [gpt, setGpt] = useState(false);
  const rows = [
    { ic: 'zap' as IconName, b: 'Anthropic', s: 'claude-opus-4.8 · default', v: 'grn' as const, t: 'Live' },
    { ic: 'globe' as IconName, b: 'OpenAI', s: 'gpt-5.2 · 12k tokens left', v: 'grn' as const, t: 'Live' },
    { ic: 'db' as IconName, b: 'Local · Ollama', s: 'qwen3:14b · offline', v: 'dim' as const, t: 'Idle' },
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="AI providers" sub="BYOK · vault-encrypted" onBack={() => router.back()} right={<Icon name="plus" size={14} color={Dot(0.38)} />} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SL>Connected</SL>
          {rows.map((r, i) => (
            <Enter key={r.b} delay={stagger(i, 80)}>
              <Row
                icon={r.ic}
                title={r.b}
                sub={r.s}
                end={<Badge variant={r.v}>{r.t}</Badge>}
              />
            </Enter>
          ))}
          <SL>API key · anthropic</SL>
          <Enter delay={260}>
            <Field />
          </Enter>
          <SL>Models in this chat</SL>
          <Enter delay={320}>
            <Row
              icon="checkc"
              title="claude-opus-4.8"
              sub="selected · 200k context"
              end={<Toggle value={opus} onChange={setOpus} />}
            />
          </Enter>
          <Enter delay={380}>
            <Row
              icon="checkc"
              title="gpt-5.2"
              sub="fast · tools-heavy chats"
              end={<Toggle value={gpt} onChange={setGpt} />}
            />
          </Enter>
          <Enter delay={440}>
            <GlassCard style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <StateDot state="done" size={6} />
              <RT style={{ fontSize: 9.5, color: Dot(0.7) }}>
                Diagnostics: streaming ✓ · sandbox ✓ · web tools ✓
              </RT>
            </GlassCard>
          </Enter>
        </View>
      </Scroll>
    </View>
  );
}

/* S26 · Custom tools & slash commands */
export function S26CustomTools() {
  const router = useRouter();
  const { tones } = useAccent();
  const [lane, setLane] = useState(0);
  const [slashCode, setSlashCode] = useState(true);
  const [slashImage, setSlashImage] = useState(true);
  const [slashAgent, setSlashAgent] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Custom tools" sub="webhooks · python · commands" onBack={() => router.back()} right={<Icon name="plus" size={14} color={Dot(0.38)} />} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <Enter delay={40}>
            <Seg
              options={[{ icon: 'plug' as IconName, label: 'HTTP' }, { icon: 'term' as IconName, label: 'Python' }]}
              value={lane}
              onChange={setLane}
            />
          </Enter>
          {lane === 0 ? (
            <Enter delay={100} y={18}>
              <GlassCard>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
                  <RT style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: Dot(0.5) }}>meme_generator · webhook</RT>
                  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <RT style={{ fontSize: 9, color: Dot(0.55) }}>200 OK</RT>
                    <StateDot state="done" size={6} />
                  </View>
                </View>
                <View style={{ borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', paddingHorizontal: 9, paddingVertical: 7 }}>
                  <RT style={{ fontFamily: 'monospace', fontSize: 8.8, lineHeight: 15, color: tones.codeStr }}>
                    <RT style={{ color: Dot(0.34) }}>POST</RT> https://api.memegen.dev/v1{`\n`}
                    {'{'} <RT style={{ color: Dot(0.34) }}>"style":</RT> <RT style={{ color: tones.accSoft }}>"orange-glass"</RT> {'}'}
                  </RT>
                </View>
              </GlassCard>
            </Enter>
          ) : (
            <Enter delay={100} y={18}>
              <GlassCard>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
                  <RT style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: Dot(0.5) }}>sentiment.py · snippet</RT>
                  <View style={{ marginLeft: 'auto' }}>
                    <PressScale scale={0.85}><Icon name="copy" size={11} color={Dot(0.45)} /></PressScale>
                  </View>
                </View>
                <View style={{ borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', paddingHorizontal: 9, paddingVertical: 7 }}>
                  <RT style={{ fontFamily: 'monospace', fontSize: 8.8, lineHeight: 15, color: tones.codeStr }}>
                    <RT style={{ color: Dot(0.34) }}>def</RT> run(text):{`\n`}
                    {'  '}<RT style={{ color: Dot(0.34) }}>return</RT> score(text) <RT style={{ color: Dot(0.34) }}>/ 10</RT>
                  </RT>
                </View>
              </GlassCard>
            </Enter>
          )}
          <SL>Slash commands</SL>
          <Row
            icon="term"
            title="/code"
            sub="run python in sandbox"
            end={<Toggle value={slashCode} onChange={setSlashCode} />}
          />
          <Row
            icon="img"
            title="/image"
            sub="generate with pollinations"
            end={<Toggle value={slashImage} onChange={setSlashImage} />}
          />
          <Row
            icon="bot"
            title="/agent"
            sub="spawn a subagent"
            end={<Toggle value={slashAgent} onChange={setSlashAgent} />}
          />
          <StFoot>Custom commands sync to every subagent</StFoot>
        </View>
      </Scroll>
    </View>
  );
}

/* S27 · Schedules & approvals — approve/deny with animated swap */
export function S27Automation() {
  const router = useRouter();
  const { tones } = useAccent();
  const [daily, setDaily] = useState(true);
  const [weekly, setWeekly] = useState(false);
  const [verdict, setVerdict] = useState<null | 'approved' | 'denied'>(null);
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Automation" sub="schedules · approvals · background" onBack={() => router.back()} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SL>Schedules</SL>
          <Row
            icon="cal"
            title="Daily liquidity report"
            sub="every day · 09:00 · @analyst"
            end={<Toggle value={daily} onChange={setDaily} />}
          />
          <Row
            icon="cal"
            title="Weekly security audit"
            sub="Mondays · 07:30 · security_audit"
            end={<Toggle value={weekly} onChange={setWeekly} />}
          />
          <SL>Awaiting approval</SL>
          {verdict === null ? (
            <Enter delay={120} y={20}>
              <GlassCard style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="term" size={12} color={tones.accXh} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>run_terminal</RT>
                    <RT style={{ fontSize: 8.5, color: Dot(0.45) }}>npm publish agent-kit</RT>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <RT style={{ fontSize: 9, color: Dot(0.55) }}>Waiting</RT>
                    <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: WARN, shadowColor: WARN, shadowOpacity: 0.7, shadowRadius: 8 }} />
                  </View>
                </View>
                <ApprBtns
                  onApprove={() => setVerdict('approved')}
                  onDeny={() => setVerdict('denied')}
                />
              </GlassCard>
            </Enter>
          ) : (
            <Enter key={verdict} delay={0} y={14}>
              <GlassCard style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StateDot state={verdict === 'approved' ? 'done' : 'queued'} size={6} />
                <RT style={{ fontSize: 9.5, color: Dot(0.8) }}>
                  npm publish agent-kit — <RT style={{ color: verdict === 'approved' ? GREEN : '#FFA9A9', fontWeight: '700' }}>
                    {verdict === 'approved' ? 'approved, publishing…' : 'denied, kept in the queue'}
                  </RT>
                </RT>
              </GlassCard>
            </Enter>
          )}
          <SL>Background tasks</SL>
          <Enter delay={200} y={18}>
            <GlassCard style={{ gap: 7 }}>
              <View style={{ gap: 5 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="cloudup" size={11} color={tones.accXh} />
                  </View>
                  <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>workspace-sync</RT>
                  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <StateDot state="run" size={6} />
                    <RT style={{ fontSize: 9, color: Dot(0.55) }}>9 files</RT>
                  </View>
                </View>
                <PBar w={64} />
              </View>
              <View style={{ gap: 5 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="db" size={11} color={tones.accXh} />
                  </View>
                  <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>indexing risk-params.md</RT>
                  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <StateDot state="run" size={6} />
                    <RT style={{ fontSize: 9, color: Dot(0.55) }}>24 chunks</RT>
                  </View>
                </View>
                <PBar w={28} />
              </View>
            </GlassCard>
          </Enter>
          <StFoot>skip-wait available on long tasks</StFoot>
        </View>
      </Scroll>
    </View>
  );
}
