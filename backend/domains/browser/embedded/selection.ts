/** The one Chromium profile used by all browser-session providers. Loading stays lazy until a provider is opened or a message is sent; the profile owns its tabs and persistent sign-in state. */
import { logWarn } from '../../../infrastructure/settings/logger.js';
import type { IntegratedBrowser } from './host.js';

type IntegratedBrowserModule = typeof import('./index.js');

let loaded: IntegratedBrowserModule | null = null;
let loading: Promise<IntegratedBrowserModule> | null = null;
const listeners = new Set<(browser: IntegratedBrowser) => void>();

/** The built-in browser if it was ever selected in this process, else null without loading it. */
export function loadedIntegratedBrowser(): IntegratedBrowser | null {
  return loaded?.integratedBrowser ?? null;
}

/** Runs once the module loads, or at once if it already has. */
export function onIntegratedBrowserLoaded(listener: (browser: IntegratedBrowser) => void): () => void {
  listeners.add(listener);
  if (loaded) listener(loaded.integratedBrowser);
  return () => listeners.delete(listener);
}

function load(): Promise<IntegratedBrowserModule> {
  loading ??= import('./index.js').then(module => {
    loaded = module;
    for (const listener of listeners) listener(module.integratedBrowser);
    return module;
  }).catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}

/** For callers acting on the private browser: loads it when it is not loaded yet. */
export async function loadIntegratedBrowser(): Promise<IntegratedBrowser> {
  return (await load()).integratedBrowser;
}

/** Keeps the private provider browser available after first use. */
export async function syncIntegratedBrowser(): Promise<void> {
  try { (await load()).syncIntegratedBrowser(); }
  catch (error) { logWarn(`integrated browser: could not load: ${error instanceof Error ? error.message : String(error)}`); }
}
