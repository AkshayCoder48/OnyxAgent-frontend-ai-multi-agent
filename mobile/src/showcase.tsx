/** The two original showcase scenes — UI 2 (store card) and UI 3 (glass menu). */
import React, { useState } from 'react';
import { Text as RT, View, useWindowDimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle, Defs, Ellipse, G, LinearGradient as SvgLinear, Path, Polygon,
  RadialGradient, Rect, Stop, Use,
} from 'react-native-svg';
import { Icon, type IconName } from './icons';
import { Bob, Enter, PressScale } from './motion';
import { useAccent } from './accent';

/* ============================ UI 2 · STORE CARD ============================= */

const SILK_A: ReadonlyArray<readonly [string, string]> = [
  ['#F7CDB8', 'M-30,105 C60,55 170,140 255,100 S370,50 430,85 L430,360 -30,360 Z'],
  ['#F0A893', 'M-30,160 C70,110 180,195 270,150 S385,105 430,145 L430,360 -30,360 Z'],
  ['#E4705F', 'M-30,220 C80,170 165,255 285,215 S395,185 430,220 L430,360 -30,360 Z'],
  ['#C9455C', 'M-30,278 C75,235 195,298 295,265 S400,242 430,272 L430,360 -30,360 Z'],
];
const SILK_B: ReadonlyArray<readonly [string, string]> = [
  ['#F5B0AC', 'M-30,95 C80,140 170,60 260,105 S370,150 430,110 L430,360 -30,360 Z'],
  ['#EC7089', 'M-30,155 C90,195 180,115 275,160 S380,205 430,160 L430,360 -30,360 Z'],
  ['#E4576B', 'M-30,215 C75,255 175,175 285,220 S390,262 430,222 L430,360 -30,360 Z'],
  ['#D0475E', 'M-30,275 C85,308 185,240 290,278 S395,312 430,280 L430,360 -30,360 Z'],
];

function SilkArt({ waves, bg, stroke }: { waves: ReadonlyArray<readonly [string, string]>; bg: string; stroke: string }) {
  const wavePath = waves[0][1];
  const crest = wavePath.slice(0, wavePath.indexOf(' L'));
  return (
    <View style={{ flex: 1, borderRadius: 38, overflow: 'hidden', backgroundColor: bg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' }}>
      <Svg viewBox="0 0 400 330" preserveAspectRatio="xMidYMid slice" style={{ flex: 1 }}>
        <Rect width="400" height="330" fill={bg} />
        {waves.map(([c, d], i) => (
          <Path key={i} d={d} fill={c} opacity={0.9} />
        ))}
        <Path d={crest} stroke={stroke} strokeWidth={30} strokeLinecap="round" fill="none" opacity={0.75} />
        {/* no feGaussianBlur in RN-SVG — wash the art back for the same softness */}
        <Rect width="400" height="330" fill={bg} opacity={0.22} />
        <Rect y="230" width="400" height="120" fill="rgba(150,70,60,0.10)" />
      </Svg>
    </View>
  );
}

const MENU_ITEMS: Array<{ ic: IconName; label: string }> = [
  { ic: 'asterisk', label: 'In Progress' },
  { ic: 'checkc', label: 'Completed' },
  { ic: 'xb', label: 'Failed' },
  { ic: 'ban', label: 'Cancelled' },
];

export function StoreCardShowcase() {
  const [sel, setSel] = useState(0);
  const win = useWindowDimensions();
  const scale = Math.min(1, (win.width - 24) / 920);
  return (
    <View style={{ flex: 1, backgroundColor: '#E9E9EB', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <Enter y={26} from={0.95} style={{ transform: [{ scale }] }}>
        <View
          style={{
            width: 920, backgroundColor: '#F8F6F4', borderRadius: 64, borderWidth: 1, borderColor: '#ECEAE6',
            paddingHorizontal: 28, paddingTop: 28, paddingBottom: 26,
            shadowColor: 'rgba(20,10,8,1)', shadowOpacity: 0.13, shadowRadius: 80, shadowOffset: { width: 0, height: 34 },
          }}
        >
          <View style={{ flexDirection: 'row', gap: 16, height: 330, position: 'relative' }}>
            <View style={{ flex: 1 }}>
              <SilkArt waves={SILK_A} bg="#FBEADD" stroke="#FFF7EF" />
            </View>
            <View style={{ flex: 1 }}>
              <SilkArt waves={SILK_B} bg="#F9D4CF" stroke="#FFF9F6" />
            </View>

            <View style={{ position: 'absolute', left: '50%', marginLeft: -145, top: 108, width: 290, borderRadius: 24, overflow: 'hidden' }}>
              <BlurView intensity={40} tint="light" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
              <View style={{ backgroundColor: 'rgba(255,244,242,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)', borderRadius: 24, padding: 10 }}>
                {MENU_ITEMS.map((m, i) => {
                  const on = i === sel;
                  return (
                    <PressScale key={m.label} scale={0.97} onPress={() => setSel(i)} style={{ borderRadius: 16 }}>
                      <View
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 15, borderRadius: 16,
                          backgroundColor: on ? 'rgba(255,255,255,0.68)' : 'transparent',
                        }}
                      >
                        <Icon name={m.ic} size={22} color="#161412" />
                        <RT style={{ fontSize: 21, fontWeight: 500, letterSpacing: -0.1, color: '#1c1a19' }}>{m.label}</RT>
                      </View>
                    </PressScale>
                  );
                })}
              </View>
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 34, paddingHorizontal: 12, paddingBottom: 6 }}>
            {[
              { ic: 'store' as IconName, l: 'Store' },
              { ic: 'search' as IconName, l: 'Search' },
            ].map((n) => (
              <PressScale key={n.l} scale={0.95} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
                <Icon name={n.ic} size={25} color="#1f1f1f" />
                <RT style={{ fontSize: 15, fontWeight: 500, color: '#1f1f1f' }}>{n.l}</RT>
              </PressScale>
            ))}
            <PressScale scale={0.96} style={{ marginHorizontal: 10 }}>
              <View
                style={{
                  width: 190, height: 74, marginTop: -28, borderRadius: 999, backgroundColor: '#111',
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 30, shadowOffset: { width: 0, height: 14 },
                  borderWidth: 1, borderTopColor: 'rgba(255,255,255,0.14)',
                  position: 'relative',
                }}
              >
                <Icon name="basket" size={34} color="#fff" />
                <View style={{ position: 'absolute', top: 7, right: 66, width: 24, height: 24, borderRadius: 999, backgroundColor: '#D5E834', borderWidth: 2.5, borderColor: '#111' }} />
              </View>
            </PressScale>
            {[
              { ic: 'bm' as IconName, l: 'Saved' },
              { ic: 'user' as IconName, l: 'Profile' },
            ].map((n) => (
              <PressScale key={n.l} scale={0.95} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
                <Icon name={n.ic} size={25} color="#1f1f1f" />
                <RT style={{ fontSize: 15, fontWeight: 500, color: '#1f1f1f' }}>{n.l}</RT>
              </PressScale>
            ))}
          </View>
        </View>
      </Enter>
    </View>
  );
}

/* ====================== UI 3 · GLASS MENU OVER TERRACES ===================== */

const BANDS: ReadonlyArray<readonly [string, number, string]> = [
  ['bandA', 0, '#71883a'], ['bandB', 60, '#68852f'], ['bandC', 122, '#54762c'],
  ['bandA', 184, '#628033'], ['bandB', 246, '#426629'], ['bandC', 308, '#385825'],
  ['bandA', 370, '#48702c'], ['bandB', 432, '#2e5120'], ['bandC', 494, '#3b6525'],
  ['bandA', 556, '#27481c'], ['bandB', 618, '#335621'], ['bandC', 680, '#203e17'],
  ['bandA', 742, '#2b4a1d'], ['bandB', 804, '#1a3513'], ['bandC', 866, '#234017'],
  ['bandA', 928, '#162d10'], ['bandB', 990, '#142a0f'],
];
const EDGES_DARK: ReadonlyArray<readonly ['edgeA' | 'edgeB' | 'edgeC', number]> = [
  ['edgeA', 60], ['edgeB', 122], ['edgeC', 184], ['edgeA', 246], ['edgeB', 308], ['edgeC', 370],
  ['edgeA', 432], ['edgeB', 494], ['edgeC', 556], ['edgeA', 618], ['edgeB', 680], ['edgeC', 742],
  ['edgeA', 804], ['edgeB', 866], ['edgeC', 928], ['edgeB', 990],
];
const EDGES_LIGHT: ReadonlyArray<readonly ['edgeA' | 'edgeB' | 'edgeC', number]> = [
  ['edgeB', 122], ['edgeA', 370], ['edgeC', 556], ['edgeB', 804],
];
const EDGES_FAINT: ReadonlyArray<readonly ['edgeA' | 'edgeB' | 'edgeC', number]> = [
  ['edgeA', 78], ['edgeB', 140], ['edgeC', 202], ['edgeA', 264], ['edgeB', 326], ['edgeC', 388],
  ['edgeA', 450], ['edgeB', 512], ['edgeC', 574], ['edgeA', 636], ['edgeB', 698], ['edgeC', 760],
  ['edgeA', 822], ['edgeB', 884], ['edgeC', 946],
];
const EDGES_FAINT2: ReadonlyArray<readonly ['edgeA' | 'edgeB' | 'edgeC', number]> = [
  ['edgeB', 98], ['edgeC', 160], ['edgeA', 222], ['edgeB', 284], ['edgeC', 346], ['edgeA', 408],
  ['edgeB', 470], ['edgeC', 532], ['edgeA', 594], ['edgeB', 656], ['edgeC', 718], ['edgeA', 780],
  ['edgeB', 842], ['edgeC', 904],
];
const TREES: ReadonlyArray<readonly [number, number, number, number]> = [
  [250, 446, 10, 6], [905, 652, 12, 7], [1320, 500, 9, 5.5], [520, 758, 11, 6.5],
  [1150, 812, 13, 7], [420, 560, 8, 5], [1450, 700, 10, 6],
];
const TREES2: ReadonlyArray<readonly [number, number, number, number]> = [
  [180, 955, 26, 16], [420, 985, 30, 18], [700, 965, 24, 15], [980, 990, 28, 17],
  [1240, 960, 26, 16], [1480, 985, 30, 18], [60, 990, 24, 15], [860, 950, 18, 11], [560, 940, 16, 10],
];

const MENU3: Array<{ ic: IconName; label: string }> = [
  { ic: 'homef', label: 'Dashboard' },
  { ic: 'search', label: 'Search' },
  { ic: 'chart', label: 'Sales Analytics' },
  { ic: 'bell', label: 'Notification' },
  { ic: 'gear', label: 'Account Settings' },
];

export function TerracesShowcase() {
  const [sel, setSel] = useState(0);
  const { tones } = useAccent();
  return (
    <View style={{ flex: 1, backgroundColor: '#0a2412', position: 'relative', overflow: 'hidden' }}>
      <Bob dx={14} dy={6} dur={52000} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
        <Svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style={{ flex: 1 }}>
          <Defs>
            <SvgLinear id="skyG" x1="0" y1="0" x2="0.55" y2="0.9">
              <Stop offset="0" stopColor="#e6edd8" />
              <Stop offset="0.45" stopColor="#d3dfc2" />
              <Stop offset="1" stopColor="#b7c9a6" stopOpacity="0" />
            </SvgLinear>
            <RadialGradient id="sunG" cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor="#fffbe8" stopOpacity={0.95} />
              <Stop offset="0.55" stopColor="#f9f4d4" stopOpacity={0.45} />
              <Stop offset="1" stopColor="#f9f4d4" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="warmG" cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor="#ffe9a8" stopOpacity={0.5} />
              <Stop offset="1" stopColor="#ffe9a8" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="vigG" cx="0.5" cy="0.45" r="0.75">
              <Stop offset="0.45" stopColor="#000" stopOpacity="0" />
              <Stop offset="1" stopColor="#04130a" stopOpacity={0.62} />
            </RadialGradient>
            <Path id="bandA" d="M-40,300 C240,258 460,336 720,300 C1000,264 1250,190 1640,-40 L1640,30 C1250,260 1000,334 720,370 C460,406 240,328 -40,370 Z" />
            <Path id="bandB" d="M-40,318 C260,286 430,344 700,312 C980,280 1260,208 1640,-26 L1640,44 C1260,278 980,350 700,382 C430,414 260,356 -40,388 Z" />
            <Path id="bandC" d="M-40,292 C220,262 480,330 760,294 C1020,262 1280,186 1640,-52 L1640,18 C1280,256 1020,332 760,364 C480,398 220,332 -40,362 Z" />
            <Path id="edgeA" d="M-40,300 C240,258 460,336 720,300 C1000,264 1250,190 1640,-40" fill="none" />
            <Path id="edgeB" d="M-40,318 C260,286 430,344 700,312 C980,280 1260,208 1640,-26" fill="none" />
            <Path id="edgeC" d="M-40,292 C220,262 480,330 760,294 C1020,262 1280,186 1640,-52" fill="none" />
          </Defs>

          <Rect x="-100" y="-100" width="1800" height="1200" fill="url(#skyG)" />
          <Circle cx={150} cy={120} r={430} fill="url(#sunG)" />

          {BANDS.map(([id, y, fill], i) => (
            <Use key={`band${i}`} href={`#${id}`} y={y} fill={fill} />
          ))}

          <G stroke="rgba(12,32,12,0.32)" strokeWidth={3} fill="none">
            {EDGES_DARK.map(([id, y], i) => (
              <Use key={`ed${i}`} href={`#${id}`} y={y} />
            ))}
          </G>
          <G stroke="rgba(240,248,214,0.3)" strokeWidth={2.5} fill="none">
            {EDGES_LIGHT.map(([id, y], i) => (
              <Use key={`el${i}`} href={`#${id}`} y={y} />
            ))}
          </G>
          <G stroke="rgba(255,255,240,0.07)" strokeWidth={1.5} fill="none">
            {EDGES_FAINT.map(([id, y], i) => (
              <Use key={`ef${i}`} href={`#${id}`} y={y} />
            ))}
          </G>
          <G stroke="rgba(10,30,10,0.09)" strokeWidth={1.5} fill="none">
            {EDGES_FAINT2.map(([id, y], i) => (
              <Use key={`ef2${i}`} href={`#${id}`} y={y} />
            ))}
          </G>

          <G fill="#1c3a16" opacity={0.85}>
            {TREES.map(([cx, cy, rx, ry], i) => (
              <Ellipse key={`t${i}`} cx={cx} cy={cy} rx={rx} ry={ry} />
            ))}
          </G>

          <G transform="translate(724,272)">
            <Rect x={8} y={14} width={34} height={18} rx={2} fill="#7a6244" />
            <Path d="M0,16 Q25,-5 50,16 Z" fill="#241a12" />
            <Rect x={21} y={21} width={9} height={11} rx={1.5} fill="#3a2c1d" />
          </G>

          <G opacity={0.9}>
            <Ellipse cx={-40} cy={560} rx={240} ry={190} fill="#1c3a1e" opacity={0.85} />
            <Ellipse cx={-60} cy={760} rx={280} ry={210} fill="#163318" opacity={0.9} />
            <Ellipse cx={120} cy={920} rx={320} ry={200} fill="#122b14" />
          </G>
          <G>
            <Ellipse cx={380} cy={1030} rx={430} ry={150} fill="#0e2410" />
            <Ellipse cx={900} cy={1050} rx={460} ry={160} fill="#122b13" />
            <Ellipse cx={1380} cy={1030} rx={430} ry={150} fill="#0c2010" />
            <Ellipse cx={640} cy={1000} rx={380} ry={120} fill="#16301a" opacity={0.9} />
          </G>
          <G fill="#132b15" opacity={0.85}>
            {TREES2.map(([cx, cy, rx, ry], i) => (
              <Ellipse key={`b${i}`} cx={cx} cy={cy} rx={rx} ry={ry} />
            ))}
          </G>

          <G opacity={0.4}>
            <Ellipse cx={520} cy={330} rx={720} ry={70} fill="#eef3dc" opacity={0.4} />
            <Ellipse cx={260} cy={200} rx={480} ry={180} fill="#f2f5e4" opacity={0.5} />
            <Ellipse cx={700} cy={470} rx={800} ry={46} fill="#e8f0d8" opacity={0.22} />
            <Ellipse cx={500} cy={610} rx={760} ry={40} fill="#e6efd6" opacity={0.16} />
            <Ellipse cx={1200} cy={430} rx={520} ry={60} fill="#e8f0d8" opacity={0.15} />
          </G>

          <G opacity={0.6}>
            <Polygon points="20,10 280,70 470,560 350,620" fill="#f7f8e6" opacity={0.55} />
            <Polygon points="280,-10 460,30 700,520 580,590" fill="#f4f6df" opacity={0.4} />
          </G>

          <Circle cx={1360} cy={240} r={420} fill="url(#warmG)" />
          <Rect x="-100" y="-100" width="1800" height="1200" fill="#0a2412" opacity={0.32} />
          <Rect x="-100" y="-100" width="1800" height="1200" fill="url(#vigG)" />
        </Svg>
      </Bob>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', marginLeft: '-4.5%', marginTop: '-3%' }}>
        <Enter y={16} from={0.985} dur={420}>
          <View style={{ width: 470, maxWidth: '92%', borderRadius: 30, overflow: 'hidden' }}>
            <BlurView intensity={28} tint="dark" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
            <View style={{ backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', borderRadius: 30, padding: 16, gap: 10 }}>
              {MENU3.map((m, i) => {
                const on = i === sel;
                return (
                  <PressScale key={m.label} scale={0.97} onPress={() => setSel(i)} style={{ borderRadius: 22 }}>
                    <View
                      style={{
                        height: 66, paddingHorizontal: 22, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 16,
                        borderWidth: 1, borderColor: on ? 'rgba(255,255,255,0.95)' : 'transparent',
                        overflow: 'hidden',
                        ...(on ? { shadowColor: 'rgba(255,255,255,0.24)', shadowOpacity: 1, shadowRadius: 36, shadowOffset: { width: 0, height: 10 } } : {}),
                      }}
                    >
                      {on && (
                        <LinearGradient colors={['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.22)']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
                      )}
                      <Icon name={m.ic} size={23} color={on ? tones.accPale : 'rgba(255,255,255,0.92)'} />
                      <RT style={{ fontSize: 19, letterSpacing: 0.1, color: '#fff', fontWeight: on ? '500' : '400' }}>
                        {m.label}
                      </RT>
                    </View>
                  </PressScale>
                );
              })}
              <Bob dx={3} dy={4} style={{ position: 'absolute', top: '62%', right: 30 }}>
                <Icon name="cursor" size={25} color="#fff" />
              </Bob>
            </View>
          </View>
        </Enter>
      </View>
    </View>
  );
}
