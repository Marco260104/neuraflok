import { t } from '../../shared/i18n.js';

export function composerTurnNowLabel(input: {
  preparing: boolean;
  working: boolean;
  pending: boolean;
  hasProject?: boolean;
}): string | null {
  if (input.preparing && input.hasProject !== false) return t('Reading project…');
  if (input.pending || input.preparing) return t('Thinking…');
  return null;
}
