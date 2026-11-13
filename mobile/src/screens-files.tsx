/** Screens S12–S14 — “Files & knowledge” group. Design unit: 276×570. */
import React, { useState } from 'react';
import { Text as RT, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  Badge, ChatBar, Cites, Dot, Enter, FakeLine, GlassCard, GreenRow, MsgAI, MsgU, PageBlock,
  SrcRow, UplBox, Scroll, SL, StFoot, StHead, stagger,
} from './kit';
import { Icon, type IconName } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';
import { GREEN } from './theme';

/* S12 · Files drawer — OPFS sidebar over the thread */
export function S12Files() {
  const { tones } = useAccent();
  const files: Array<[IconName, string, string, boolean?]> = [
    ['folder', 'assets', '12'],
    ['folder', 'data', '4'],
    ['file', 'bot.ts', '8.1 KB', true],
    ['file', 'risk-params.md', '2.2 KB'],
    ['img', 'orb.svg', '14 KB'],
    ['file', 'report.pdf', '310 KB'],
  ];
  return (
    <View style={{ flex: 1, position: 'relative' }}>
      <View style={{ flex: 1, flexDirection: 'column', gap: 12, paddingHorizontal: 14, paddingTop: 14 }} pointerEvents="none">
        <MsgU>Add the risk doc to the workspace</MsgU>
        <MsgAI>Indexed. It syncs to the sandbox before every run.</MsgAI>
      </View>
      <ChatBar placeholder="Ask AI a question" />
      <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '66%', paddingHorizontal: 10, paddingBottom: 12 }}>
        <View style={{ flex: 1, borderRadius: 0, overflow: 'hidden', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(30,13,4,0.34)' }}>
          <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 8, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 8 }}>
              <View style={{ flex: 1 }}>
                <RT style={{ fontSize: 12.5, fontWeight: '700', color: '#fff' }}>Files</RT>
                <RT style={{ fontSize: 9, color: Dot(0.4) }}>OPFS · on-device</RT>
              </View>
              <Icon name="up" size={13} color={Dot(0.38)} />
            </View>
            {files.map(([ic, t, meta, on], i) => (
              <Enter key={t} delay={stagger(i, 70)}>
                <PressScale scale={0.97} onPress={() => {}} style={{ borderRadius: 11 }}>
                  <View
                    style={[
                      {
                        flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 11,
                        borderWidth: 1.2, borderColor: 'transparent',
                      },
                      on
                        ? { backgroundColor: 'rgba(255,255,255,0.28)', borderColor: 'rgba(255,255,255,0.92)', shadowColor: 'rgba(255,255,255,0.16)', shadowOpacity: 1, shadowRadius: 22, shadowOffset: { width: 0, height: 0 } }
                        : undefined,
                    ]}
                  >
                    <Icon name={ic} size={13} color={on ? tones.accPale : Dot(0.48)} />
                    <RT numberOfLines={1} style={{ flex: 1, fontSize: 10.5, color: on ? '#fff' : Dot(0.76) }}>{t}</RT>
                    <RT style={{ fontSize: 8.5, color: Dot(0.35) }}>{meta}</RT>
                  </View>
                </PressScale>
              </Enter>
            ))}
            <View style={{ marginTop: 6 }}>
              <UplBox>Upload</UplBox>
            </View>
            <View style={{ flex: 1 }} />
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12,
                backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
              }}
            >
              <Icon name="checkc" size={13} color={GREEN} />
              <View style={{ flex: 1 }}>
                <RT style={{ fontSize: 10, fontWeight: '600', color: '#fff' }}>Synced to sandbox</RT>
                <RT style={{ fontSize: 9, color: Dot(0.5) }}>.onyxagent_files.json · 9 files</RT>
              </View>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/* S13 · File preview — Code / Preview segmented, both live */
export function S13FilePreview() {
  const [seg, setSeg] = useState(0);
  const { tones } = useAccent();
  const router = useRouter();
  return (
    <View style={{ flex: 1 }}>
      <StHead
        back
        title="bot.ts"
        sub="8.1 KB · edited by @coder 2m ago"
        onBack={() => router.back()}
        right={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="dl" size={14} color={Dot(0.38)} />
            <Icon name="trash" size={14} color={Dot(0.38)} />
          </View>
        }
      />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SegCodePreview value={seg} onChange={setSeg} />
          {seg === 0 ? (
            <Enter delay={60} y={18}>
              <GlassCard>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6, paddingHorizontal: 2 }}>
                  <RT style={{ fontSize: 8.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, color: Dot(0.5) }}>read_file · bot.ts</RT>
                  <View style={{ marginLeft: 'auto' }}>
                    <PressScale scale={0.85}><Icon name="copy" size={11} color={Dot(0.45)} /></PressScale>
                  </View>
                </View>
                <View
                  style={{
                    borderRadius: 10, backgroundColor: 'rgba(10,4,1,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
                    paddingHorizontal: 9, paddingVertical: 7,
                  }}
                >
                  <RT style={{ fontFamily: 'monospace', fontSize: 8.8, lineHeight: 15, color: tones.codeStr }}>
                    <RT style={{ color: Dot(0.34) }}>1</RT>  {'export'} {'const'} guard = {'{'}{`\n`}
                    <RT style={{ color: Dot(0.34) }}>2</RT>    slippage: <RT style={{ color: tones.accSoft }}>0.008</RT>,{`\n`}
                    <RT style={{ color: Dot(0.34) }}>3</RT>    drawdown: <RT style={{ color: tones.accSoft }}>-0.12</RT>,{`\n`}
                    <RT style={{ color: Dot(0.34) }}>4</RT>    rebalance: <RT style={{ color: tones.accSoft }}>"6h"</RT>,{`\n`}
                    <RT style={{ color: Dot(0.34) }}>5</RT>  {'}'} <RT style={{ color: Dot(0.34) }}>as const</RT>;{`\n`}
                    <RT style={{ color: Dot(0.34) }}>6</RT>{`\n`}
                    <RT style={{ color: Dot(0.34) }}>7</RT>  <RT style={{ color: Dot(0.34) }}>export function</RT> shouldTrim(p) {'{'}{`\n`}
                    <RT style={{ color: Dot(0.34) }}>8</RT>    <RT style={{ color: Dot(0.34) }}>return</RT> p.drawdown &lt; guard.drawdown;
                  </RT>
                </View>
              </GlassCard>
            </Enter>
          ) : (
            <Enter delay={60} y={18}>
              <GlassCard>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="browser" size={12} color={tones.accXh} />
                  </View>
                  <RT style={{ fontSize: 10.5, fontWeight: '600', color: Dot(0.92) }}>preview_html · live</RT>
                  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <RT style={{ fontSize: 9, color: Dot(0.55) }}>Rendered</RT>
                    <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: GREEN }} />
                  </View>
                </View>
                <View style={{ marginTop: 7 }}>
                  <GlassCard style={{ padding: 8, backgroundColor: 'rgba(0,0,0,0.30)' }}>
                    <View>
                      <FakeLine w="55%" />
                      <FakeLine w="80%" hl />
                      <FakeLine w="68%" mg={7} />
                      <PageBlock h={34} />
                    </View>
                  </GlassCard>
                </View>
              </GlassCard>
            </Enter>
          )}
          <StFoot>Binary-safe blobs · auto-sync before run_python</StFoot>
        </View>
      </Scroll>
    </View>
  );
}

function SegCodePreview({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { tones } = useAccent();
  const opts: Array<{ ic: IconName; l: string }> = [
    { ic: 'code', l: 'Code' },
    { ic: 'browser', l: 'Preview' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 5 }}>
      {opts.map((o, i) => {
        const on = i === value;
        return (
          <PressScale key={o.l} scale={0.96} onPress={() => onChange(i)} style={{ flex: 1 }}>
            <View
              style={{
                height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, overflow: 'hidden',
                backgroundColor: on ? 'transparent' : 'rgba(255,255,255,0.07)',
                borderWidth: 1, borderColor: on ? 'transparent' : 'rgba(255,255,255,0.12)',
              }}
            >
              {on && (
                <LinearGradient colors={tones.seg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
              )}
              <Icon name={o.ic} size={12} color={on ? '#fff' : 'rgba(255,255,255,0.55)'} />
              <RT style={{ fontSize: 10, fontWeight: '600', color: on ? '#fff' : 'rgba(255,255,255,0.55)' }}>{o.l}</RT>
            </View>
          </PressScale>
        );
      })}
    </View>
  );
}

/* S14 · Knowledge base */
export function S14KB() {
  const router = useRouter();
  const { tones } = useAccent();
  const docs: Array<[string, string, 'grn' | 'acc']> = [
    ['widget-guidelines.md', '142 chunks · updated 1h ago', 'grn'],
    ['design-system.pdf', '89 chunks · updated 1d ago', 'grn'],
    ['risk-params.md', '24 chunks · updated 5h ago', 'acc'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Knowledge base" sub="e2b_rag · 3 documents indexed" onBack={() => router.back()} right={<Icon name="plus" size={14} color={Dot(0.38)} />} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          {docs.map(([t, s, bv], i) => (
            <Enter key={t} delay={stagger(i, 90)}>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 13,
                  backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
                }}
              >
                <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="file" size={14} color={tones.accXh} />
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{t}</RT>
                  <RT style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>{s}</RT>
                </View>
                <Badge variant={bv}>{bv === 'grn' ? 'Indexed' : 'Queued'}</Badge>
              </View>
            </Enter>
          ))}
          <View style={{ marginTop: 4 }}>
            <UplBox>Drop PDFs, MD or ZIP to index</UplBox>
          </View>
          <SL>Cited in chat</SL>
          <Enter delay={280} y={20}>
            <GlassCard>
              <SrcRow
                fav="W"
                domain="widget-guidelines.md · chunk 12"
                title={'"…the orb must glow at 45% brand color, never pure white…"'}
              />
              <View style={{ marginTop: 8 }}>
                <Cites nums={[1, 2, 3]} note="sources panel" />
              </View>
            </GlassCard>
          </Enter>
          <StFoot>Answers cite the exact chunk they came from</StFoot>
        </View>
      </Scroll>
    </View>
  );
}
