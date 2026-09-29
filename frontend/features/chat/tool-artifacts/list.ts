import type { ToolCallRecord } from '../../../../contracts/session.js';
import { el } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';
import { renderEditCard } from './card.js';

export function renderEditCards(call: ToolCallRecord, sessionId: string, current: () => boolean): HTMLElement {
  const cards = el('div', 'edit-cards');
  const changes = call.changes ?? [];
  for (const [index, change] of changes.slice(0, 32).entries()) {
    cards.append(renderEditCard(call, sessionId, index, change, current));
  }
  if (changes.length > 32) cards.append(el('p', 'meta', () => t('More edited files are available in the recording.')));
  return cards;
}
