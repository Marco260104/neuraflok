import { ui, t } from '../../shared/i18n.js';
import type { BrowserPreferences } from '../../../contracts/browser/preferences.js';
import { $ } from '../../shared/dom.js';

type PreferencePhase = 'idle' | 'loading' | 'confirmed' | 'unavailable';

interface PreferenceViewState {
  phase: PreferencePhase;
  preferences: BrowserPreferences | null;
  message: string;
}

/** Extension acknowledgments are read-only until confirmed. */
export function initBrowserPreferences(): void {
  const overwrite = $<HTMLInputElement>('browserOverwrite');
  const durations = $<HTMLInputElement>('browserDurations');
  const refresh = $<HTMLButtonElement>('browserPreferencesRefresh');
  const status = $('browserPreferencesStatus');
  let state: PreferenceViewState = { phase: 'idle', preferences: null, message: '' };

  const paint = (): void => {
    const canEdit = state.phase === 'confirmed' && state.preferences !== null;
    overwrite.disabled = durations.disabled = !canEdit;
    refresh.disabled = state.phase === 'loading';
    overwrite.checked = state.preferences?.overwrite ?? false;
    durations.checked = state.preferences?.durations ?? false;
    const message = state.message;
    if (message) ui(status, 'textContent', () => t(message));
  };

  const request = async (patch: Partial<BrowserPreferences> = {}): Promise<void> => {
    if (state.phase === 'loading') return;
    state = { ...state, phase: 'loading', message: 'Waiting for the extension to confirm…' };
    paint();
    try {
      const response = await window.api.browserPreferences(patch);
      state = response.ok
        ? { phase: 'confirmed', preferences: response.data, message: 'Confirmed by the browser extension.' }
        : { phase: 'unavailable', preferences: null, message: response.error };
    } catch {
      state = { phase: 'unavailable', preferences: null, message: 'Unable to reach the extension. Connect it and refresh.' };
    }
    paint();
  };

  overwrite.addEventListener('change', () => void request({ overwrite: overwrite.checked }));
  durations.addEventListener('change', () => void request({ durations: durations.checked }));
  refresh.addEventListener('click', () => void request());

  if (typeof IntersectionObserver === 'function') {
    let wasVisible = false;
    new IntersectionObserver(entries => {
      const isVisible = entries.some(entry => entry.isIntersecting);
      if (isVisible && !wasVisible && state.preferences === null) void request();
      wasVisible = isVisible;
    }).observe(overwrite.closest('.setting') ?? overwrite);
  }

  paint();
}
