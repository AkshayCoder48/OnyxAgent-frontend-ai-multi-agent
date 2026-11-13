import { describe, expect, it } from 'vitest';
import { ALL_SCREENS, APP, GROUPS } from '../registry';

const KINDS = new Set(['home', 'tools', 'chat', 'side', 'plain', 'onboard']);

describe('clone suite registry', () => {
  it('has all 7 groups in order', () => {
    expect(GROUPS.map((g) => g.label)).toEqual([
      'Chat experience',
      'Onboarding & input',
      'Subagent orchestration',
      'Files & knowledge',
      'Tool results, made pretty',
      'Library',
      'Settings',
    ]);
  });

  it('covers exactly the 27 clone screens', () => {
    expect(ALL_SCREENS).toHaveLength(27);
    GROUPS.forEach((g) => expect(g.screens.length).toBeGreaterThan(0));
  });

  it('has unique ids and routes', () => {
    expect(new Set(ALL_SCREENS.map((s) => s.id)).size).toBe(27);
    expect(new Set(ALL_SCREENS.map((s) => s.route)).size).toBe(27);
  });

  it('every screen has a title and a valid kind', () => {
    for (const s of ALL_SCREENS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(KINDS.has(s.kind)).toBe(true);
    }
  });

  it('routes are legal expo-router paths', () => {
    for (const s of ALL_SCREENS) {
      expect(s.route.startsWith('/')).toBe(true);
      if (s.route !== '/') expect(s.route).not.toMatch(/\/$/);
    }
    expect(ALL_SCREENS[0].route).toBe('/');
  });

  it('app metadata matches the webapp version', () => {
    expect(APP.name).toBe('OnyxAgent');
    expect(APP.version).toBe('2.4.0');
  });
});
