/** Shared route wrappers: dark canvas + safe areas; ClonePage scales the 276×570 design. */
import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen, Scaled, type ScreenKind } from './kit';

export function ClonePage({ kind, children, max = 1.62 }: { kind: ScreenKind; children?: ReactNode; max?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: '#0B0200', paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Scaled max={max}>
        <Screen kind={kind}>{children}</Screen>
      </Scaled>
    </View>
  );
}

export function FullPage({ kind, children, light = false }: { kind: ScreenKind; children?: ReactNode; light?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: light ? '#E9E9EB' : '#0B0200', paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Screen kind={kind}>{children}</Screen>
    </View>
  );
}
