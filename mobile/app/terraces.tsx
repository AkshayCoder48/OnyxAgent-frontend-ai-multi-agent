import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TerracesShowcase } from '../src/showcase';

export default function Page() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: '#0a2412', paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <TerracesShowcase />
    </View>
  );
}
