/**
 * The app's glass sidebar host — the S4 clone drawer as a real, animated panel:
 * scrim fade + spring slide-in. Pure reanimated (no navigator dependency).
 */
import React, { useMemo, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { GlassSidebar } from './screens-chat';
import { SPRING } from './motion';
import { SidebarCtx, useSidebar } from './sidebar-context';

export { useSidebar };

export function SidebarProvider({ children }: { children?: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const value = useMemo(
    () => ({ open: () => setOpen(true), close: () => setOpen(false), isOpen }),
    [isOpen],
  );
  return (
    <SidebarCtx.Provider value={value}>
      {children}
      <GlassDrawerHost open={isOpen} onClose={() => setOpen(false)} />
    </SidebarCtx.Provider>
  );
}

function GlassDrawerHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const panel = useAnimatedStyle(() => ({
    transform: [{ translateX: withSpring(open ? 0 : -320, SPRING.soft) }],
  }));
  if (!open) return null;
  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} pointerEvents="box-none">
      <Pressable style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(5,1,0,0.45)' }} onPress={onClose} accessibilityLabel="Close sidebar" />
      <Animated.View
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '72%',
        }}
      >
        <Animated.View style={[{ flex: 1 }, panel]}>
          <GlassSidebar
            onNavigate={(r) => {
              onClose();
              router.push(r as never);
            }}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}
