import { WEB_PROVIDERS } from '../../../contracts/web-providers.js';
import { getSession } from '../sessions/history/store.js';
import { listInputs, retryUnclaimedInput } from '../sessions/input/input.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { wakeBrowserUrl } from './browser-startup.js';

interface Runtime {
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  isBridgeDesiredRunning(): boolean;
  hasBridgeServer(): boolean;
  backgroundChats(): boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export function createBridgeUnclaimedInputRecovery(runtime: Runtime) {
  let sweep: Promise<void> | null = null;

  function retryUnclaimedBrowserInputs(): Promise<void> {
    if (sweep) return sweep;
    const pass = (async () => {
      const inputs = await listInputs();
      for (const row of inputs) {
        if (row.state !== 'failed' || row.error !== 'Not sent: the browser did not pick up this message within 60 seconds.' ||
            !row.sessionId || !row.conversationId || !runtime.recoveryInputAllowed(row.sessionId, row.conversationId)) continue;
        const provider = providerForConversationId(row.conversationId);
        if (!provider) continue;
        const retried = await retryUnclaimedInput(row.id);
        if (!retried) continue;
        runtime.logInfo(`recovery monitor: requeued the same never-authorized browser input ${row.id}`);
        const stillOwned = async (): Promise<boolean> => {
          if (!runtime.isBridgeDesiredRunning() || !runtime.hasBridgeServer() ||
              !runtime.recoveryInputAllowed(row.sessionId!, row.conversationId!)) return false;
          const [latestRows, session] = await Promise.all([listInputs(), getSession(row.sessionId!)]);
          const latest = latestRows.find(entry => entry.id === row.id);
          return !!session && session.conversationId === row.conversationId && latest?.state === 'queued' &&
            latest.pickupRetryCount === 1 && latest.sendAuthorizedAt === undefined && latest.deliveredAt === undefined;
        };
        try {
          await wakeBrowserUrl(WEB_PROVIDERS[provider].chatUrl, false, runtime.backgroundChats(), { current: stillOwned });
        } catch (error) {
          runtime.logWarn(`recovered browser input ${row.id} remains queued because its chat could not be opened: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    sweep = pass;
    const clear = () => { if (sweep === pass) sweep = null; };
    void pass.then(clear, clear);
    return pass;
  }

  return { retryUnclaimedBrowserInputs };
}
