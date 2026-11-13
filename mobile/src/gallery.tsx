/**
 * The clone suite — the literal three-ui.html experience, native: live orb,
 * live swatches, 27 phone frames in 7 groups, both showcases linked below.
 */
import React from 'react';
import { ScrollView, Text as RT, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Dot, Orb, PhoneChrome, PhoneFrame, Screen, SwatchRow, DESIGN_W } from './kit';
import { APP, GROUPS, type ScreenDef } from './registry';
import { SCREENS } from './screens-map';
import { Breathe, Enter, Halo, PressScale, stagger } from './motion';
import { useAccent } from './accent';
import { Icon } from './icons';

export function Gallery() {
  const { tones } = useAccent();
  const router = useRouter();
  const win = useWindowDimensions();
  const cols = win.width >= 1100 ? 4 : win.width >= 700 ? 3 : 2;
  const rowW = Math.min(win.width - 16, 1340);
  const frameW = (rowW - (cols - 1) * 30) / cols;
  const scale = frameW / DESIGN_W;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingBottom: 40, paddingTop: 14 }}>
      {/* header */}
      <View style={{ alignItems: 'center' }}>
        <Enter y={24} from={0.9}>
          <View style={{ alignItems: 'center' }}>
            <Breathe>
              <View>
                <Halo color={tones.glow(0.45)} size={130} strength={0.5} style={{ top: -36, left: -36 }} />
                <Orb size={58} glow={false} />
              </View>
            </Breathe>
            <RT style={{ fontSize: 30, fontWeight: '700', color: '#fff', letterSpacing: -0.4, marginTop: 14 }}>
              Onyx
              <RT style={{ color: tones.accHi }}>{'Agent'}</RT>
            </RT>
            <RT style={{ marginTop: 7, fontSize: 12.5, color: Dot(0.5), lineHeight: 20, textAlign: 'center', paddingHorizontal: 20 }}>
              {APP.tagline}
            </RT>
          </View>
        </Enter>
        <Enter delay={120} style={{ marginTop: 18 }}>
          <SwatchRow />
        </Enter>
        <Enter delay={180}>
          <RT style={{ marginTop: 10, fontSize: 10, color: Dot(0.34), textAlign: 'center', paddingHorizontal: 24 }}>
            Default is orange — tap any color to re-skin the whole app (saved, just like the repo's brand picker).
          </RT>
        </Enter>
      </View>

      {GROUPS.map((g, gi) => (
        <View key={g.label} style={{ width: rowW, marginTop: gi === 0 ? 26 : 8 }}>
          <GroupLabel label={g.label} />
          <RT style={{ fontSize: 11, color: Dot(0.32), marginBottom: 10, alignSelf: 'center' }}>{g.sub}</RT>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 30, justifyContent: 'center' }}>
            {g.screens.map((s, i) => (
              <GalleryItem key={s.id} s={s} scale={scale} delay={stagger(i, 70, 420)} onOpen={() => router.push(s.route as never)} />
            ))}
          </View>
        </View>
      ))}

      {/* showcases */}
      <View style={{ width: rowW, marginTop: 26 }}>
        <GroupLabel label="Original scenes" />
        <RT style={{ fontSize: 11, color: Dot(0.32), marginBottom: 10, alignSelf: 'center' }}>
          Store card · glass menu — the two standalone scenes from the clone file
        </RT>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 30, justifyContent: 'center' }}>
          {([
            ['/store-card', 'store', 'Store card', 'Artworks + glass dropdown + nav'],
            ['/terraces', 'globe', 'Glass menu', 'Over terraced rice fields'],
          ] as const).map(([route, ic, t, sub], i) => (
            <Enter key={route} delay={stagger(i, 90)}>
              <PressScale scale={0.97} onPress={() => router.push(route as never)} style={{ width: frameW - 40, maxWidth: 320 }}>
                <View style={{ borderRadius: 15, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)', borderTopColor: 'rgba(255,255,255,0.30)', padding: 14, gap: 7 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name={ic} size={14} color={tones.accXh} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <RT style={{ fontSize: 11, fontWeight: '600', color: Dot(0.92) }}>{t}</RT>
                      <RT style={{ fontSize: 8.8, color: Dot(0.42) }}>{sub}</RT>
                    </View>
                    <Icon name="chevr" size={12} color={Dot(0.3)} />
                  </View>
                </View>
              </PressScale>
            </Enter>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

function GroupLabel({ label }: { label: string }) {
  const { tones } = useAccent();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: tones.glow(0.45), opacity: 0.8 }} />
      <RT style={{ fontSize: 11, fontWeight: '600', letterSpacing: 2.6, textTransform: 'uppercase', color: Dot(0.55) }}>
        {label}
      </RT>
      <View style={{ flex: 1, height: 1, backgroundColor: tones.glow(0.45), opacity: 0.8 }} />
    </View>
  );
}

function GalleryItem({ s, scale, delay, onOpen }: { s: ScreenDef; scale: number; delay: number; onOpen: () => void }) {
  const Comp = SCREENS[s.id];
  if (!Comp) return null;
  const h = 570 * scale + 8;
  return (
    <Enter delay={delay} y={26} from={0.94}>
      <PressScale scale={0.98} onPress={onOpen}>
        <View style={{ width: DESIGN_W * scale, height: h }}>
          <View style={{ width: DESIGN_W, height: 570, transform: [{ scale }], transformOrigin: 'top left' }}>
            <PhoneFrame>
              <Screen kind={s.kind}>
                <PhoneChrome />
                <View style={{ flex: 1, paddingTop: 54 }}>
                  <Comp />
                </View>
              </Screen>
            </PhoneFrame>
          </View>
        </View>
      </PressScale>
    </Enter>
  );
}
