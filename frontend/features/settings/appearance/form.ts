import { defaultAppearance, type AppearanceSettings, type AppearanceTheme } from '../../../../contracts/appearance-settings.js';
import type { UiPrefs } from '../../../../contracts/types.js';
import { $ } from '../../../shared/dom.js';
import { applyAppearance } from './palette.js';

type ColorKey = 'accent' | 'background' | 'sidebar';
type AppearancePatch = { theme?: AppearanceTheme; appearance?: AppearanceSettings };
type Draft = { theme: AppearanceTheme; settings: AppearanceSettings; editing: boolean };
type Controls = {
  theme: HTMLSelectElement;
  font: HTMLSelectElement;
  size: HTMLInputElement;
  sizeValue: HTMLOutputElement;
  contrast: HTMLInputElement;
  contrastValue: HTMLOutputElement;
  translucent: HTMLInputElement;
  colors: Record<ColorKey, { picker: HTMLInputElement; hex: HTMLInputElement }>;
};

const COLOR_KEYS: ColorKey[] = ['accent', 'background', 'sidebar'];

function required<T extends HTMLElement>(panel: HTMLElement, selector: string): T {
  const element = panel.querySelector<T>(selector);
  if (!element) throw new Error(`Missing appearance control: ${selector}`);
  return element;
}

function controlsFor(panel: HTMLElement): Controls {
  return {
    theme: required(panel, '#appearanceTheme'),
    font: required(panel, '#appearanceFont'),
    size: required(panel, '#appearanceSize'),
    sizeValue: required(panel, '#appearanceSizeValue'),
    contrast: required(panel, '#appearanceContrast'),
    contrastValue: required(panel, '#appearanceContrastValue'),
    translucent: required(panel, '#appearanceTranslucent'),
    colors: Object.fromEntries(COLOR_KEYS.map(key => [key, {
      picker: required(panel, `[data-color="${key}"]`),
      hex: required(panel, `[data-hex="${key}"]`)
    }])) as Controls['colors']
  };
}

function colorKey(value: string | undefined): value is ColorKey {
  return value === 'accent' || value === 'background' || value === 'sidebar';
}

function paint(draft: Draft, fields: Controls): void {
  const palette = draft.settings[draft.theme];
  applyAppearance(draft.theme, draft.settings);
  fields.theme.value = draft.theme;
  fields.font.value = draft.settings.font;
  fields.size.value = String(draft.settings.fontSize);
  fields.sizeValue.textContent = `${draft.settings.fontSize} px`;
  fields.contrast.value = String(palette.contrast);
  fields.contrastValue.textContent = String(palette.contrast);
  fields.translucent.checked = draft.settings.translucentSidebar;
  for (const key of COLOR_KEYS) {
    const value = palette[key];
    fields.colors[key].picker.value = value;
    if (document.activeElement !== fields.colors[key].hex) fields.colors[key].hex.value = value.toUpperCase();
  }
}

function updateDraft(draft: Draft, control: HTMLInputElement | HTMLSelectElement, fields: Controls): boolean {
  const keyValue = control.dataset.color ?? control.dataset.hex;
  if (keyValue !== undefined) {
    if (!colorKey(keyValue)) return false;
    const value = control.value.trim();
    if (!/^#[\da-fA-F]{6}$/.test(value)) {
      control.setAttribute('aria-invalid', 'true');
      return false;
    }
    control.removeAttribute('aria-invalid');
    draft.settings = { ...draft.settings, [draft.theme]: { ...draft.settings[draft.theme], [keyValue]: value.toLowerCase() } };
    if (control.dataset.color) fields.colors[keyValue].hex.value = value.toUpperCase();
  } else if (control.id === 'appearanceSize') draft.settings = { ...draft.settings, fontSize: Number(control.value) };
  else if (control.id === 'appearanceContrast') draft.settings = { ...draft.settings, [draft.theme]: { ...draft.settings[draft.theme], contrast: Number(control.value) } };
  else if (control.id === 'appearanceFont') draft.settings = { ...draft.settings, font: control.value as AppearanceSettings['font'] };
  else if (control.id === 'appearanceTranslucent') draft.settings = { ...draft.settings, translucentSidebar: (control as HTMLInputElement).checked };
  else return false;
  paint(draft, fields);
  return true;
}

function restoreInvalidHex(control: HTMLInputElement, draft: Draft, fields: Controls): void {
  const key = control.dataset.hex;
  if (!colorKey(key)) return;
  control.removeAttribute('aria-invalid');
  control.value = draft.settings[draft.theme][key].toUpperCase();
  fields.colors[key].picker.value = draft.settings[draft.theme][key];
}

export function initAppearance(save: (patch: AppearancePatch) => void): { apply(ui: UiPrefs): void } {
  const panel = $('appearancePanel');
  const fields = controlsFor(panel);
  const draft: Draft = { theme: 'dark', settings: defaultAppearance(), editing: false };

  panel.addEventListener('input', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || !control.id.startsWith('appearance')) return;
    draft.editing = true;
    updateDraft(draft, control, fields);
  });

  panel.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id.startsWith('appearance')) return;
    draft.editing = false;
    if (control.id === 'appearanceTheme') {
      draft.theme = control.value as AppearanceTheme;
      paint(draft, fields);
      save({ theme: draft.theme });
    } else if (updateDraft(draft, control, fields)) save({ appearance: draft.settings });
    else if (control instanceof HTMLInputElement) restoreInvalidHex(control, draft, fields);
  });

  $('appearanceReset').addEventListener('click', () => {
    draft.editing = false;
    draft.settings = defaultAppearance();
    paint(draft, fields);
    save({ appearance: draft.settings });
  });

  return {
    apply(ui) {
      if (draft.editing) return;
      draft.theme = ui.theme;
      draft.settings = ui.appearance ?? defaultAppearance();
      paint(draft, fields);
    }
  };
}
