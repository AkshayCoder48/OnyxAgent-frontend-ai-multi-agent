import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_ACCENT, tonesFor, type Tones } from './theme';

/**
 * The live skin. Same persistence key as the clone HTML (`oa.brand`) — the
 * whole app re-skins instantly from one accent, just like the gallery swatches.
 */
const KEY = 'oa.brand';

interface AccentCtx {
  accent: string;
  tones: Tones;
  setAccent: (hex: string) => void;
  ready: boolean;
}

const Ctx = createContext<AccentCtx>({
  accent: DEFAULT_ACCENT,
  tones: tonesFor(DEFAULT_ACCENT),
  setAccent: () => {},
  ready: false,
});

export function AccentProvider({ children }: { children: ReactNode }) {
  const [accent, setA] = useState(DEFAULT_ACCENT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (!alive) return;
        if (v && /^#[0-9a-fA-F]{6}$/.test(v)) setA(v);
        setReady(true);
      })
      .catch(() => alive && setReady(true));
    return () => { alive = false; };
  }, []);

  const value = useMemo<AccentCtx>(
    () => ({
      accent,
      tones: tonesFor(accent),
      ready,
      setAccent: (hex: string) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        setA(hex);
        AsyncStorage.setItem(KEY, hex).catch(() => {});
      },
    }),
    [accent, ready],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAccent = () => useContext(Ctx);
