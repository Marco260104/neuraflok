import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { afterEach, vi } from 'vitest';
import { initWebModelLoading, markInitialBootComplete } from '../frontend/features/browser/web-model-loading.js';
import { webModelLoadingPhase } from '../frontend/features/browser/web-model-loading.js';
import type { AppState } from '../contracts/types.js';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

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

it('lets the user dismiss the web-model connection overlay without reopening it on state updates', () => {
  dom = new JSDOM(`
    <div id="webModelLoading" hidden>
      <div class="web-model-loading-card">
        <button id="webModelLoadingClose" type="button" aria-label="Close" title="Close"></button>
        <h2 id="webModelLoadingTitle"></h2>
        <p id="webModelLoadingDetail"></p>
        <button id="webModelLoadingAction" type="button"></button>
      </div>
    </div>
  `, { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  const controller = initWebModelLoading({ showBrowser: vi.fn(async () => undefined) });
  markInitialBootComplete();

  controller.paint(state({ signedIn: null }));
  const overlay = document.getElementById('webModelLoading')!;
  expect(overlay.hidden).toBe(false);
  document.getElementById('webModelLoadingClose')!.click();
  expect(overlay.hidden).toBe(true);

  controller.paint(state({ signedIn: null }));
  expect(overlay.hidden).toBe(true);
  controller.paint(state({ signedIn: true }));
  expect(overlay.hidden).toBe(false);
  expect(document.getElementById('webModelLoadingTitle')!.textContent).toBe('Ready');
});
