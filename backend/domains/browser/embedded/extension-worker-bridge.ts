import type { BrowserControl } from './chrome-api/index.js';
import { callChromeApi } from './chrome-api/index.js';
import { ExtensionWorkerLink, type WorkerRegistry, type WorkerStatus } from './extension-worker.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { randomUUID } from 'node:crypto';

const TRACE = process.env.IETEGRATED_BROWSER_TRACE === '1';

function traceIds(args: unknown[]): string {
  return args.map(arg => typeof arg === 'number' ? String(arg)
    : arg && typeof arg === 'object' && 'tabId' in arg ? `tab ${String((arg as { tabId: unknown }).tabId)}`
      : arg && typeof arg === 'object' && 'id' in arg ? `#${String((arg as { id: unknown }).id)}`
        : typeof arg).join(', ');
}

export class IntegratedBrowserExtensionBridge {
  private link: ExtensionWorkerLink | null = null;
  private readonly pendingReveals = new Map<string, { resolve(shown: boolean): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly control: BrowserControl) {
  }

  connect(workers: WorkerRegistry, extensionId: string): void {
    this.link = new ExtensionWorkerLink(workers, `chrome-extension://${extensionId}/`,
      (name, args) => this.answer(name, args), logWarn);
  }

  announceStartup(): void {
    this.send('runtime.onStartup', []);
  }

  statusChanged(versionId: number, runningStatus: WorkerStatus): void {
    this.link?.statusChanged(versionId, runningStatus);
  }

  send(name: string, args: unknown[]): void {
    if (TRACE && name !== 'debugger.onEvent') {
      const change = name === 'tabs.onUpdated' ? ` ${JSON.stringify(Object.keys(args[1] as object))}` : '';
      logInfo(`integrated browser trace: event ${name}(${traceIds(args.slice(0, 1))})${change}`);
    }
    this.link?.send(name, args);
  }

  /** Ask the extension running in this browser profile to reveal its exact saved conversation. */
  revealProviderConversation(conversationId: string): Promise<boolean> {
    if (!this.link) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.settleReveal(requestId, false), 15_000);
      timer.unref?.();
      this.pendingReveals.set(requestId, { resolve, timer });
      this.send('neuraflok.reveal-provider-conversation', [requestId, conversationId]);
    });
  }

  close(): void {
    this.link?.close();
    this.link = null;
    for (const requestId of this.pendingReveals.keys()) this.settleReveal(requestId, false);
  }

  private async answer(name: string, args: unknown): Promise<unknown> {
    if (name === 'neuraflok.reveal-result') {
      if (Array.isArray(args) && typeof args[0] === 'string' && typeof args[1] === 'boolean') {
        this.settleReveal(args[0], args[1]);
      }
      return { ok: true, value: undefined };
    }
    const label = TRACE ? `${name}(${Array.isArray(args) ? traceIds(args) : ''})` : '';
    const late = TRACE ? setTimeout(() => logWarn(`integrated browser trace: ${label} still pending after 10 s`), 10_000) : null;
    try {
      const reply = await callChromeApi(this.control, name, args);
      if (TRACE) logInfo(`integrated browser trace: ${label} ${reply.ok ? 'ok' : `failed: ${reply.message}`}`);
      return reply;
    } finally {
      if (late) clearTimeout(late);
    }
  }

  private settleReveal(requestId: string, shown: boolean): void {
    const pending = this.pendingReveals.get(requestId);
    if (!pending) return;
    this.pendingReveals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(shown);
  }
}
