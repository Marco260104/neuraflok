import { z } from 'zod';
import { APPEARANCE_FONTS } from './appearance-settings.js';

const rgbHexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const contrastPercent = z.number().int().min(0).max(100);
const palette = z.object({
  background: rgbHexColor,
  sidebar: rgbHexColor,
  accent: rgbHexColor,
  contrast: contrastPercent
});

export const appearanceSettingsSchema = z.object({
  light: palette,
  dark: palette,
  font: z.enum(APPEARANCE_FONTS),
  fontSize: z.number().int().min(12).max(18),
  translucentSidebar: z.boolean()
});
