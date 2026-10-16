import { randomUUID } from 'node:crypto';
import { BROWSER_LIMITS, type BrowserCommand, type BrowserResult, type BrowserTool } from '../../../../contracts/browser/control-policy.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { BrowserClientDirectory } from './client-directory.js';
import { PendingBrowserRequests } from './pending-requests.js';
import type { BrowserOwnerProof, PendingBrowserRequest } from './types.js';

const browserIdentity = /^[a-f\d-]{36}$/i;
const tabReference = /^([a-f\d-]{36}):(\d+)$/i;

export class BrowserControlBroker {
  private epoch = randomUUID();
  private readonly clients = new BrowserClientDirectory();
  private readonly requests = new PendingBrowserRequests();

  constructor(private readonly wake = () => wakeBrowserWork('browser-control')) {}

  browsers(): Array<{ id: string; name: string; enabled: boolean }> {
    return this.clients.list();
  }

  poll(browserId: string, name: string, enabled: boolean): { epoch: string; requests: string[] } {
    if (!browserIdentity.test(browserId)) throw new Error('Invalid browser identity');
    this.clients.heartbeat(browserId, name, enabled);
    return {
      epoch: this.epoch,
      requests: enabled ? this.requests.availableFor(browserId) : []
    };
  }

  async claim(
    browserId: string,
    requestId: string,
    epoch: string,
    ownerProofs: ReadonlyArray<BrowserOwnerProof> = []
  ): Promise<BrowserCommand | null> {
    const request = this.requests.get(requestId);
    if (!this.matches(request, browserId, epoch) || request.claimed || request.claiming) return null;
    request.claiming = true;

    const allowed = await request.allowed().catch(() => false);
    if (this.requests.get(requestId) !== request || request.command.expiresAt <= Date.now()) return null;
    if (!allowed) {
      this.requests.complete(requestId, { error: 'BROWSER_PERMISSION_REVOKED: request was not dispatched.' });
      return null;
    }

    const aliases = [...new Set(ownerProofs.slice(0, 32)
      .filter(proof => proof.owner.startsWith('request:') && `session:${proof.sessionId}` === request.command.owner)
      .map(proof => proof.owner))];
    if (aliases.length) request.command.ownerAliases = aliases;
    request.claimed = true;
    return request.command;
  }

  result(browserId: string, requestId: string, epoch: string, result: BrowserResult): boolean {
    const request = this.requests.get(requestId);
    if (!this.matches(request, browserId, epoch) || !request.claimed) return false;

    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > BROWSER_LIMITS.resultBytes) {
      return this.requests.complete(requestId, {
        error: 'BROWSER_RESULT_TOO_LARGE: operation may have completed; inspect before repeating it.'
      });
    }
    return this.requests.complete(requestId, result);
  }

  async check(browserId: string, requestId: string, epoch: string): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!this.matches(request, browserId, epoch) || !request.claimed) return false;
    const allowed = await request.allowed().catch(() => false);
    return allowed && this.requests.get(requestId) === request && request.command.expiresAt > Date.now();
  }

  async execute(
    tool: BrowserTool,
    input: Record<string, unknown>,
    owner: string,
    conversationId: string | null,
    allowed: () => Promise<boolean>
  ): Promise<BrowserResult> {
    const args = { ...input };
    const browsers = this.browsers();
    let browserId = typeof args.browserId === 'string' ? args.browserId : undefined;

    if (typeof args.tabId === 'string') {
      const match = tabReference.exec(args.tabId);
      if (!match || !Number.isSafeInteger(Number(match[2]))) {
        return { error: 'BROWSER_TAB_INVALID: use a tabId returned by browser_tabs.' };
      }
      browserId = match[1]!;
      args.tabId = Number(match[2]);
    }

    if (!browserId) {
      if (browsers.length !== 1) {
        return tool === 'browser_tabs' && args.action === 'list'
          ? { value: {
              browsers,
              tabs: [],
              message: browsers.length ? 'Choose browserId to list its tabs.' : 'Open Chrome with the companion extension connected.'
            } }
          : { error: 'BROWSER_REQUIRED: list browsers, then specify the returned browserId.' };
      }
      browserId = browsers[0]!.id;
    }

    const client = browsers.find(browser => browser.id === browserId);
    if (!client) {
      return { error: 'BROWSER_OFFLINE: this browser incarnation is no longer connected. List browsers again.' };
    }
    if (!client.enabled) {
      return { error: 'BROWSER_EXTENSION_PERMISSION: Chrome must grant the companion its debugger and tabs permissions. Reload/update the extension.' };
    }
    if (this.requests.size >= BROWSER_LIMITS.pending) {
      return { error: 'BROWSER_BUSY: too many pending requests; no operation was dispatched.' };
    }

    delete args.browserId;
    const requestId = randomUUID();
    const command: BrowserCommand = {
      id: requestId,
      epoch: this.epoch,
      owner,
      conversationId,
      tool,
      args,
      expiresAt: Date.now() + BROWSER_LIMITS.timeoutMs
    };

    return new Promise(resolve => {
      const request: PendingBrowserRequest = {
        browserId,
        command,
        claimed: false,
        claiming: false,
        allowed,
        resolve,
        timer: null
      };
      request.timer = setTimeout(() => {
        const error = request.claimed
          ? 'BROWSER_RESULT_UNCONFIRMED: the operation was dispatched but its result was not received. Inspect the tab before repeating any action.'
          : 'BROWSER_NOT_DISPATCHED: the extension did not claim this request before its deadline.';
        this.requests.complete(requestId, { error });
      }, BROWSER_LIMITS.timeoutMs);
      request.timer.unref?.();
      this.requests.add(requestId, request);
      this.wake();
    });
  }

  reset(): void {
    this.requests.completeAll(request => ({
      error: request.claimed
        ? 'BROWSER_RESULT_UNCONFIRMED: bridge stopped after dispatch. Inspect before repeating the operation.'
        : 'BROWSER_NOT_DISPATCHED: bridge stopped.'
    }));
    this.clients.clear();
    this.epoch = randomUUID();
  }

  private matches(request: PendingBrowserRequest | undefined, browserId: string, epoch: string): request is PendingBrowserRequest {
    return Boolean(request && request.browserId === browserId && epoch === this.epoch);
  }
}
