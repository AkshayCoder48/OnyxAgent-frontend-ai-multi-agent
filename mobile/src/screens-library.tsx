/** Screens S20–S22 — “Library” group. Design unit: 276×570. */
import React, { useState } from 'react';
import { Text as RT, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Badge, Dot, Enter, GlassCard, SKCard, Scroll, SL, StFoot, StHead, Toggle,
  Tiles, Tile, UplBox, stagger, StateDot,
} from './kit';
import { Icon, type IconName } from './icons';
import { PressScale } from './motion';
import { useAccent } from './accent';
import { OKS } from './kit';

/* S20 · Tools library */
export function S20Tools() {
  const { tones } = useAccent();
  const groups: Array<{ label: string; tiles: Array<{ ic: IconName; t: string; st?: string }> }> = [
    {
      label: 'Code & files',
      tiles: [
        { ic: 'term', t: 'run_python', st: 'E2B' },
        { ic: 'term', t: 'run_terminal' },
        { ic: 'file', t: 'create_file' },
        { ic: 'pen', t: 'edit_file' },
        { ic: 'folder', t: 'list_files' },
        { ic: 'search', t: 'search_files' },
      ],
    },
    {
      label: 'Web & search',
      tiles: [
        { ic: 'search', t: 'ddg_search' },
        { ic: 'globe', t: 'web_fetch' },
        { ic: 'browser', t: 'use_browser' },
      ],
    },
    {
      label: 'Subagents · viz · memory · utils',
      tiles: [
        { ic: 'bot', t: 'spawn_subagent' },
        { ic: 'chart', t: 'create_chart' },
        { ic: 'img', t: 'preview_image' },
        { ic: 'db', t: 'memory' },
        { ic: 'listcheck', t: 'todos' },
      ],
    },
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead
        title="Tools"
        sub="51 available · sandbox-enabled"
        right={<Badge>50+</Badge>}
      />
      <Scroll>
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 6 }}>
          {groups.map((g, gi) => (
            <View key={g.label}>
              <SL>{g.label}</SL>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                {g.tiles.map((t, i) => (
                  <Enter key={t.t} delay={stagger(i, 45, 400) + gi * 60} from={0.92}>
                    <Tile icon={t.ic} label={t.t} st={t.st} />
                  </Enter>
                ))}
                {gi === groups.length - 1 && (
                  <Enter delay={stagger(5, 45) + 120} from={0.92}>
                    <Tile icon="plus" label="+38" more />
                  </Enter>
                )}
              </View>
            </View>
          ))}
          <StFoot>security_audit · workflow · datetime · mcp_tools · skill_tools …</StFoot>
        </View>
      </Scroll>
    </View>
  );
}

/* S21 · Skills marketplace — installs flip live */
export function S21Skills() {
  const router = useRouter();
  const { tones } = useAccent();
  const [meme, setMeme] = useState(false);
  const [i18n, setI18n] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="Skills" sub="SkillsMP marketplace · 2 installed" onBack={() => router.back()} right={<Icon name="up" size={14} color={Dot(0.38)} />} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          <SL>Installed</SL>
          <Enter delay={60}>
            <SKCard icon="layers" title="SVG Artisan" sub="draws complex, layered SVG art" desc="Used 14 times · provided the orb hero set" installed />
          </Enter>
          <Enter delay={120}>
            <SKCard icon="chart" title="Data Analyst" sub="pandas + charts in sandbox" desc="Used 6 times · this week's volume plot" installed />
          </Enter>
          <SL>Marketplace</SL>
          <Enter delay={180} y={18}>
            <SKCard
              icon="spark" title="Meme Generator" sub="top-text / bottom-text, 40 templates"
              desc="By @community · 12.4k installs · ★ 4.8"
              installed={meme} onInstall={() => setMeme(true)}
            />
          </Enter>
          <Enter delay={240} y={18}>
            <SKCard
              icon="globe" title="I18n Translator" sub="context-aware UI translations"
              desc="By @akshay · 8.1k installs · ★ 4.6"
              installed={i18n} onInstall={() => setI18n(true)}
            />
          </Enter>
          <UplBox>Upload custom skill (.zip / .md)</UplBox>
        </View>
      </Scroll>
    </View>
  );
}

/* S22 · MCP servers */
export function S22MCP() {
  const router = useRouter();
  const { tones } = useAccent();
  const [notion, setNotion] = useState(false);
  const rows: Array<{ L: string; b: string; s: string; on: boolean }> = [
    { L: 'G', b: 'GitHub', s: 'repos, issues, PRs · 7 tools', on: true },
    { L: 'P', b: 'Playwright', s: 'browser automation · 4 tools', on: true },
    { L: 'N', b: 'Notion', s: 'pages & databases · 3 tools', on: notion },
  ];
  return (
    <View style={{ flex: 1 }}>
      <StHead back title="MCP servers" sub="Model Context Protocol · 14 tools exposed" onBack={() => router.back()} />
      <Scroll>
        <View style={{ paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
          {rows.map((r, i) => (
            <Enter key={r.b} delay={stagger(i, 90)}>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 13,
                  backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
                }}
              >
                <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' }}>
                  <RT style={{ fontSize: 10, fontWeight: '700', color: tones.accXh }}>{r.L}</RT>
                </View>
                <View style={{ flex: 1 }}>
                  <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{r.b}</RT>
                  <RT style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>{r.s}</RT>
                </View>
                {r.b === 'Notion'
                  ? <Toggle value={notion} onChange={setNotion} />
                  : <StateDot state="done" size={6} />}
              </View>
            </Enter>
          ))}
          <SL>Latest activity</SL>
          <Enter delay={280}>
            <GlassCard>
              <RT style={{ fontFamily: 'monospace', fontSize: 8.6, lineHeight: 14, color: Dot(0.72) }}>
                <OKS>✓</OKS> github.search_code <RT style={{ color: Dot(0.34) }}>"hook examples"</RT>{`\n`}
                <OKS>✓</OKS> playwright.navigate <RT style={{ color: Dot(0.34) }}>defillama.com</RT>{`\n`}
                <RT style={{ color: Dot(0.34) }}>∘</RT> notion.create_page <RT style={{ color: Dot(0.34) }}>queued</RT>
              </RT>
            </GlassCard>
          </Enter>
          <Enter delay={340}>
            <PressScale scale={0.98} onPress={() => {}}>
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
                  <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.75) }}>Add MCP server</RT>
                  <RT style={{ fontSize: 8.8, color: Dot(0.42), marginTop: 1 }}>mcp_management · any transport</RT>
                </View>
              </View>
            </PressScale>
          </Enter>
          <StFoot>dynamic_tools refresh automatically on connect</StFoot>
        </View>
      </Scroll>
    </View>
  );
}
