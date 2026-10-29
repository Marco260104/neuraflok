import { usesApiProvider } from '../../../contracts/chat-protocol.js';
import type { AppState } from '../../../contracts/types.js';
import { WEB_PROVIDERS, selectableWebProviderOrDefault } from '../../../contracts/web-providers.js';
import { $ } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface WebModelLoadingActions {
  showBrowser(): Promise<unknown>;
}

let revealedSignIn = false;
let readyFlash: number | null = null;
let lastPhase: 'models' | 'signin' | 'ready' | 'hidden' = 'models';
let initialBootComplete = false;
let activeProvider = 'deepseek';
let dismissedProvider: string | null = null;

export function markInitialBootComplete(): void {
  initialBootComplete = true;
  lastPhase = 'ready';
  const overlay = document.getElementById('webModelLoading');
  if (overlay) overlay.hidden = true;
}

function selectedPresence(state: AppState) {
  const provider = selectableWebProviderOrDefault(state.config.ui.webProvider);
  return { provider, presence: state.bridge.webProviders?.[provider] ?? null };
}

export function webModelLoadingPhase(state: AppState): 'hidden' | 'models' | 'signin' | 'ready' {
  if (usesApiProvider(state.config.ui.chatExecutor)) return 'hidden';
  const { presence } = selectedPresence(state);
  if (presence?.signedIn === true) return 'ready';
  if (presence?.signedIn === false) return 'signin';
  return 'models';
}

export function initWebModelLoading(actions: WebModelLoadingActions): { paint(state: AppState): void } {
  const close = document.getElementById('webModelLoadingClose');
  if (close) {
    ui(close, 'aria-label', () => t('Close'));
    ui(close, 'title', () => t('Close'));
    close.addEventListener('click', () => {
      dismissedProvider = activeProvider;
      const overlay = document.getElementById('webModelLoading');
      if (overlay) overlay.hidden = true;
    });
  }
  $('webModelLoadingAction').addEventListener('click', () => {
    revealedSignIn = true;
    void actions.showBrowser();
  });

  function paint(state: AppState): void {
    const overlay = document.getElementById('webModelLoading') as HTMLElement | null;
    if (!overlay) return;
    const title = document.getElementById('webModelLoadingTitle') ?? overlay;
    const detail = document.getElementById('webModelLoadingDetail') ?? overlay;
    const action = (document.getElementById('webModelLoadingAction') as HTMLButtonElement | null) ?? document.createElement('button');
    const { provider, presence } = selectedPresence(state);
    activeProvider = provider;
    if (dismissedProvider !== null && dismissedProvider !== provider) dismissedProvider = null;
    const label = WEB_PROVIDERS[provider].label;
    const phase = webModelLoadingPhase(state);

    if (!initialBootComplete || phase === 'hidden') {
      overlay.hidden = true;
      lastPhase = phase;
      return;
    }



    if (phase === 'ready') {
      dismissedProvider = null;
      if (lastPhase === 'models' || lastPhase === 'signin') {
        overlay.hidden = false;
        overlay.dataset.tone = 'ready';
        ui(title, 'textContent', () => t('Ready'));
        ui(detail, 'textContent', () => t('The web model is ready.'));
        action.hidden = true;
        if (readyFlash !== null) window.clearTimeout(readyFlash);
        readyFlash = window.setTimeout(() => {
          readyFlash = null;
          overlay.hidden = true;
        }, 900);
      } else if (readyFlash === null) overlay.hidden = true;
      lastPhase = 'ready';
      revealedSignIn = false;
      return;
    }

    if (dismissedProvider === provider) {
      overlay.hidden = true;
      lastPhase = phase;
      return;
    }

    if (readyFlash !== null) {
      window.clearTimeout(readyFlash);
      readyFlash = null;
    }
    overlay.hidden = false;
    overlay.dataset.tone = phase;
    lastPhase = phase;
    if (phase === 'signin') {
      ui(title, 'textContent', () => t('Sign in required'));
      ui(detail, 'textContent', () => t('Sign in to {0} in the integrated browser.', [label]));
      action.hidden = false;
      ui(action, 'textContent', () => t('Show browser'));
      if (!revealedSignIn && presence?.open === true) {
        revealedSignIn = true;
        void actions.showBrowser();
      }
      return;
    }
    ui(title, 'textContent', () => t('Loading web models'));
    ui(detail, 'textContent', () => t('Opening the private browser and connecting to {0}.', [label]));
    action.hidden = false;
    ui(action, 'textContent', () => t('Show browser'));
  }

  return { paint };
}
