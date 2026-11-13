import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { AccentProvider } from '../src/accent';

export default function RootLayout() {
  return (
    <AccentProvider>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#0B0200' }}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#0B0200' },
            animation: 'slide_from_right',
            gestureEnabled: true,
          }}
        >
          <Stack.Screen name="store-card" options={{ animation: 'fade' }} />
          <Stack.Screen name="terraces" options={{ animation: 'fade' }} />
        </Stack>
      </GestureHandlerRootView>
    </AccentProvider>
  );
}

export const unstable_settings = { anchor: '(app)' };
