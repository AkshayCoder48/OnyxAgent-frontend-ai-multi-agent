import React from 'react';
import { Stack } from 'expo-router';
import { SidebarProvider } from '../../src/sidebar';

export default function AppLayout() {
  return (
    <SidebarProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0B0200' },
          animation: 'slide_from_right',
          gestureEnabled: true,
        }}
      />
    </SidebarProvider>
  );
}
