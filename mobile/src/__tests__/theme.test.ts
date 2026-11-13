import { describe, expect, it } from 'vitest';
import { cmix, mix, hslToHex, hexToHue, PRESETS, DEFAULT_ACCENT, tonesFor, rgba } from '../theme';

describe('color math (CSS color-mix port)', () => {
  it('cmix matches color-mix(in srgb, A r%, B) channel math', () => {
    // 45% #F07E12 + 55% white -> (248.25, 196.95, 148.35) -> #F8C594
    expect(cmix('#F07E12', 45, '#ffffff')).toBe('#f8c594');
    // 74% #F07E12 + 26% black -> (177.6, 93.24, 13.32) -> #B25D0D
    expect(cmix('#F07E12', 74, '#000000')).toBe('#b25d0d');
    // 32% acc + 68% white -> #FAD6B3
    expect(cmix('#F07E12', 32, '#ffffff')).toBe('#fad6b3');
  });

  it('mix(a, b, r) is the b-fraction blend', () => {
    // 35% #F07E12 + 65% white
    expect(mix('#F07E12', '#ffffff', 0.65)).toBe('#fad2ac');
  });

  it('rgba string', () => {
    expect(rgba('#F07E12', 0.45)).toBe('rgba(240,126,18,0.45)');
  });
});

describe('tones', () => {
  const t = tonesFor('#F07E12');
  it('derives the clone token set from one accent', () => {
    expect(t.acc).toBe('#F07E12');
    expect(t.accHi).toBe('#f8c594');
    expect(t.accXh).toBe(cmix('#F07E12', 25, '#ffffff'));
    expect(t.accPale).toBe(cmix('#F07E12', 65, '#ffffff'));
    expect(t.codeStr).toBe('#fad6b3');
  });
  it('screen gradients carry the exact stop counts', () => {
    expect(t.scrHome).toHaveLength(7);
    expect(t.scrHome[0]).toBe('#F07E12');
    expect(t.scrTools).toHaveLength(5);
    expect(t.scrChat).toHaveLength(5);
    expect(t.scrPlain).toHaveLength(4);
    expect(t.scrPlain[2]).toBe('#0a0301');
    expect(t.scrPlain[3]).toBe('#050100');
  });
  it('re-skins for another accent', () => {
    const blue = tonesFor('#4F6DF5');
    expect(blue.scrHome[0]).toBe('#4F6DF5');
    expect(blue.accHi).not.toBe(t.accHi);
  });
});

describe('hue picker round-trip', () => {
  it('hexToHue(hslToHex(h)) ~ h', () => {
    for (const h of [0, 30, 60, 120, 180, 240, 300, 350]) {
      const hex = hslToHex(h);
      const back = hexToHue(hex);
      const delta = Math.min(Math.abs(back - h), 360 - Math.abs(back - h));
      expect(delta).toBeLessThanOrEqual(6);
    }
  });
});

describe('presets', () => {
  it("ships the clone's five skins with orange default", () => {
    expect(PRESETS).toHaveLength(5);
    expect(PRESETS[0]).toEqual({ name: 'Orange', hex: '#F07E12' });
    expect(DEFAULT_ACCENT).toBe('#F07E12');
    expect(PRESETS.map((p) => p.hex)).toEqual(['#F07E12', '#4F6DF5', '#10B981', '#F0524D', '#8B5CF6']);
  });
});
