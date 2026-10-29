import { describe, it, expect } from 'vitest';
import { appearanceSettingsSchema } from '../contracts/appearance-validation.js';
import { contrastRatio, readableInk } from '../contracts/appearance-color.js';
import { adoptShippedAppearance, defaultAppearance, mergeAppearance } from '../contracts/appearance-settings.js';
import { paletteTokens } from '../contracts/appearance-tokens.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from '../backend/infrastructure/desktop-shell/window-layout.js';

describe('custom appearance', () => {
  it('accepts arbitrary RGB colors, including identical accent and background, and bounds other preferences', () => {
    const appearance = defaultAppearance();
    appearance.dark = { background: '#51a20F', sidebar: '#fE0193', accent: '#51a20F', contrast: 0 };
    expect(appearanceSettingsSchema.parse(appearance)).toEqual(appearance);
    for (const bad of ['red', '#fff', '#12345678', 'url(https://example.com)', '#abcdef;display:none']) {
      expect(appearanceSettingsSchema.safeParse({ ...appearance, dark: { ...appearance.dark, sidebar: bad } }).success).toBe(false);
    }
    for (const fontSize of [11, 19, 14.5, Infinity]) expect(appearanceSettingsSchema.safeParse({ ...appearance, fontSize }).success).toBe(false);
    expect(appearanceSettingsSchema.safeParse({ ...appearance, font: 'remote-font' }).success).toBe(false);
  });

  it('retains readable text and buttons across light, dark and vivid custom backgrounds', () => {
    for (const background of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#fea5cf']) {
      for (const contrast of [0, 45, 100]) {
        const tokens = paletteTokens(background, background, contrast);
        expect(contrastRatio(tokens['--ink']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--soft']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--faint']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--blue']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--on-accent']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(tokens['--accent-fill']).toBe(background);
      }
    }
  });

  it('merges stale windows per color and per theme without overwriting concurrent edits', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    live.dark.sidebar = '#ff0066'; live.light.background = '#f1f2f3'; live.font = 'serif';
    wanted.dark.accent = '#7600ff'; wanted.fontSize = 18;
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.dark).toEqual({ ...live.dark, accent: '#7600ff' });
    expect(merged.light).toEqual(live.light);
    expect(merged.font).toBe('serif'); expect(merged.fontSize).toBe(18);
    expect(mergeAppearance(live, undefined, undefined)).toBe(live);
    expect(base).toEqual(defaultAppearance());
  });

  it('moves an unedited dusk palette onto the current default and keeps a custom accent', () => {
    const shipped = {
      light: { background: '#f3f1f6', sidebar: '#ebe7f0', accent: '#c45e32', contrast: 42 },
      dark: { background: '#16141c', sidebar: '#1c1924', accent: '#e8a07a', contrast: 52 },
      font: 'serif' as const,
      fontSize: 16,
      translucentSidebar: false
    };
    expect(adoptShippedAppearance(shipped)).toEqual({ ...defaultAppearance(), font: 'serif', fontSize: 16, translucentSidebar: false });
    const custom = defaultAppearance();
    custom.dark.accent = '#ff00aa';
    expect(adoptShippedAppearance(custom)).toEqual(custom);
    expect(adoptShippedAppearance(undefined)).toBeUndefined();
  });

  it('moves the former cyan default to the neutral graphite palette without replacing custom palettes', () => {
    const oldDefault = {
      light: { background: '#eef2f5', sidebar: '#e1e7ec', accent: '#0d7480', contrast: 40 },
      dark: { background: '#141a20', sidebar: '#0c1014', accent: '#3ecad6', contrast: 50 },
      font: 'serif' as const,
      fontSize: 16,
      translucentSidebar: false
    };
    expect(adoptShippedAppearance(oldDefault)).toEqual({
      ...defaultAppearance(), font: 'serif', fontSize: 16, translucentSidebar: false
    });
    const customized = { ...oldDefault, dark: { ...oldDefault.dark, accent: '#8765ab' } };
    expect(adoptShippedAppearance(customized)).toBe(customized);
  });

  it('reduces the shipped default text size while preserving a deliberately selected size', () => {
    const previousDefault = { ...defaultAppearance(), fontSize: 14 };
    expect(adoptShippedAppearance(previousDefault)?.fontSize).toBe(12);
    const selectedSize = { ...previousDefault, fontSize: 16 };
    expect(adoptShippedAppearance(selectedSize)?.fontSize).toBe(16);
    expect(defaultAppearance().fontSize).toBe(12);
  });

  it('uses the custom sidebar for native caption contrast and the custom page for reload backing', () => {
    const appearance = defaultAppearance();
    appearance.dark.sidebar = '#ffffff'; appearance.dark.background = '#391c56'; appearance.translucentSidebar = false;
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#ffffff') });
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#391c56');
  });
});
