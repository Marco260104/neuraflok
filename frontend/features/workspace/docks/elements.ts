import { el, icon } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';

export function createDockIconButton(glyph: string, label: string): HTMLButtonElement {
  const button = el('button', 'btn btn-icon') as HTMLButtonElement;
  button.type = 'button';
  button.append(icon(glyph));
  ui(button, 'title', () => t(label));
  ui(button, 'aria-label', () => t(label));
  return button;
}
