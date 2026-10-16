import { mixColor, readableInk, readableTint } from './appearance-color.js';

export function paletteTokens(background: string, accent: string, contrast: number): Record<string, string> {
  const text = readableInk(background);
  const strength = Math.max(0, Math.min(100, contrast)) / 100;
  const surface = mixColor(background, text, 0.025 + 0.06 * strength);
  const hover = mixColor(background, text, 0.055 + 0.07 * strength);
  const tint = (color: string, base: string, ratio = 4.5) => readableTint(color, base, ratio);
  const accentText = tint(accent, background);
  const green = '#258552';
  const red = '#d44545';

  return {
    '--page': background,
    '--ink': text,
    '--card': surface,
    '--sunk': mixColor(background, text, 0.018 + 0.025 * strength),
    '--hover': hover,
    '--raise': hover,
    '--popover': mixColor(background, text, 0.06 + 0.06 * strength),
    '--soft': tint(mixColor(background, text, 0.53 + 0.2 * strength), surface),
    '--faint': tint(mixColor(background, text, 0.43 + 0.2 * strength), surface),
    '--line': mixColor(background, text, 0.09 + 0.13 * strength),
    '--edge': mixColor(background, text, 0.12 + 0.15 * strength),
    '--track': mixColor(background, text, 0.18 + 0.14 * strength),
    '--blue': accentText,
    '--accent': accentText,
    '--accent-fill': accent,
    '--on-accent': readableInk(accent),
    '--wash': mixColor(background, accent, 0.12),
    '--blue-line': mixColor(background, accent, 0.3),
    '--accent-wash': mixColor(background, accent, 0.12),
    '--accent-edge': mixColor(background, accent, 0.35),
    '--knob-off': text,
    '--knob-on': readableInk(accent),
    '--green': tint(green, surface),
    '--green-wash': mixColor(background, green, 0.12),
    '--green-line': mixColor(background, green, 0.3),
    '--red': tint(red, surface),
    '--red-wash': mixColor(background, red, 0.12),
    '--red-line': mixColor(background, red, 0.3)
  };
}
