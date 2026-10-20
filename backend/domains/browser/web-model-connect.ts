/** Opens the selected web provider in the private browser at startup. */
import { usesApiProvider } from '../../../contracts/chat-protocol.js';
import { isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { onBridgeChange, startBridge, webProvidersStatus } from './bridge.js';
import { loadIntegratedBrowser } from './embedded/selection.js';

let connecting: Promise<void> | null = null;
let watching = false;
let revealedForSignIn = false;
let stopWatch: (() => void) | null = null;

export function selectedWebProvider(): WebProviderId {
  const value = getConfig().ui.webProvider;
  return isWebProviderId(value) ? value : 'deepseek';
}

async function openSelectedProvider(reveal: boolean): Promise<void> {
  const provider = selectedWebProvider();
  const browser = await loadIntegratedBrowser();
  await browser.openProvider(provider, { reveal, hideAfterSignIn: true });
}

function watchForSignIn(): void {
  if (watching) return;
  watching = true;
  stopWatch = onBridgeChange(() => {
    if (usesApiProvider(getConfig().ui.chatExecutor)) return;
    const status = webProvidersStatus()[selectedWebProvider()];
    if (status?.signedIn === true) {
      revealedForSignIn = false;
      return;
    }
    if (status?.signedIn !== false || revealedForSignIn) return;
    revealedForSignIn = true;
    void openSelectedProvider(true).catch(() => undefined);
  });
}

/** Starts the companion, opens the selected web model in the background, and reveals the page only when a sign-in is required. */
export async function connectSelectedWebModel(): Promise<void> {
  if (usesApiProvider(getConfig().ui.chatExecutor)) return;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!await startBridge()) throw new Error('The browser bridge could not start.');
    const status = webProvidersStatus()[selectedWebProvider()];
    await openSelectedProvider(status?.signedIn === false);
    watchForSignIn();
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

export function resetWebModelConnectForTests(): void {
  connecting = null;
  watching = false;
  revealedForSignIn = false;
  stopWatch?.();
  stopWatch = null;
}
