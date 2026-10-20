import { expect, it } from 'vitest';
import { webModelLoadingPhase } from '../frontend/features/browser/web-model-loading.js';
import type { AppState } from '../contracts/types.js';

function state(over: { executor?: 'web' | 'api'; signedIn?: boolean | null }): AppState {
  return {
    config: { ui: { chatExecutor: over.executor ?? 'web', webProvider: 'deepseek' } },
    bridge: { running: true, port: 1, paired: true, present: true, lastSeenAt: 1, extensionVersion: '1',
      webProviders: { deepseek: { open: over.signedIn !== undefined, signedIn: over.signedIn ?? null, tabId: 1, lastSeenAt: 1 } } }
  } as AppState;
}

it('shows the loading overlay until the selected web model is signed in', () => {
  expect(webModelLoadingPhase(state({ signedIn: null }))).toBe('models');
  expect(webModelLoadingPhase(state({ signedIn: false }))).toBe('signin');
  expect(webModelLoadingPhase(state({ signedIn: true }))).toBe('ready');
  expect(webModelLoadingPhase(state({ executor: 'api', signedIn: null }))).toBe('hidden');
});
