import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StoreCardShowcase } from '../src/showcase';

export default function Page() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: '#E9E9EB', paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <StoreCardShowcase />
    </View>
  );
}
