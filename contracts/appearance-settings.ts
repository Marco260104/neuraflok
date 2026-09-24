export const APPEARANCE_FONTS = ['system', 'sans', 'serif', 'mono'] as const;

export type AppearanceTheme = 'light' | 'dark';

export interface AppearancePalette {
  background: string;
  sidebar: string;
  accent: string;
  contrast: number;
}

export interface AppearanceSettings {
  light: AppearancePalette;
  dark: AppearancePalette;
  font: (typeof APPEARANCE_FONTS)[number];
  fontSize: number;
  translucentSidebar: boolean;
}

export function defaultAppearance(): AppearanceSettings {
  return {
    light: { background: '#eef2f5', sidebar: '#e1e7ec', accent: '#0d7480', contrast: 40 },
    dark: { background: '#141a20', sidebar: '#0c1014', accent: '#3ecad6', contrast: 50 },
    font: 'system',
    fontSize: 14,
    translucentSidebar: true
  };
}

type Palette = AppearancePalette;

function paletteEqual(left: Palette, right: Palette): boolean {
  return left.background === right.background
    && left.sidebar === right.sidebar
    && left.accent === right.accent
    && left.contrast === right.contrast;
}

const SHIPPED_APPEARANCE_PALETTES: ReadonlyArray<{ light: Palette; dark: Palette }> = [
  {
    light: { background: '#f3f1f6', sidebar: '#ebe7f0', accent: '#c45e32', contrast: 42 },
    dark: { background: '#16141c', sidebar: '#1c1924', accent: '#e8a07a', contrast: 52 }
  }
];

export function adoptShippedAppearance(settings: AppearanceSettings | undefined): AppearanceSettings | undefined {
  if (!settings) return settings;
  const shipped = SHIPPED_APPEARANCE_PALETTES.some(old => paletteEqual(settings.light, old.light) && paletteEqual(settings.dark, old.dark));
  if (!shipped) return settings;
  const next = defaultAppearance();
  return { ...next, font: settings.font, fontSize: settings.fontSize, translucentSidebar: settings.translucentSidebar };
}

function mergeValue<T>(current: T, baseline: T, requested: T): T {
  return Object.is(baseline, requested) ? current : requested;
}

function mergePalette(current: AppearancePalette, baseline: AppearancePalette, requested: AppearancePalette): AppearancePalette {
  return {
    background: mergeValue(current.background, baseline.background, requested.background),
    sidebar: mergeValue(current.sidebar, baseline.sidebar, requested.sidebar),
    accent: mergeValue(current.accent, baseline.accent, requested.accent),
    contrast: mergeValue(current.contrast, baseline.contrast, requested.contrast)
  };
}

export function mergeAppearance(
  currentValue: AppearanceSettings | undefined,
  baselineValue: AppearanceSettings | undefined,
  requestedValue: AppearanceSettings | undefined
): AppearanceSettings | undefined {
  if (!requestedValue) return currentValue;
  const current = currentValue ?? defaultAppearance();
  const baseline = baselineValue ?? defaultAppearance();
  return {
    light: mergePalette(current.light, baseline.light, requestedValue.light),
    dark: mergePalette(current.dark, baseline.dark, requestedValue.dark),
    font: mergeValue(current.font, baseline.font, requestedValue.font),
    fontSize: mergeValue(current.fontSize, baseline.fontSize, requestedValue.fontSize),
    translucentSidebar: mergeValue(current.translucentSidebar, baseline.translucentSidebar, requestedValue.translucentSidebar)
  };
}
