import { BROWSER_LIMITS } from '../../../../contracts/browser/control-policy.js';
import type { ConnectedBrowser } from './types.js';

export class BrowserClientDirectory {
  private readonly connected = new Map<string, ConnectedBrowser>();

  list(now = Date.now()): Array<Omit<ConnectedBrowser, 'seenAt'>> {
    this.removeExpired(now);
    return [...this.connected.values()].map(({ id, name, enabled }) => ({ id, name, enabled }));
  }

  find(browserId: string, now = Date.now()): Omit<ConnectedBrowser, 'seenAt'> | undefined {
    this.removeExpired(now);
    const browser = this.connected.get(browserId);
    return browser ? { id: browser.id, name: browser.name, enabled: browser.enabled } : undefined;
  }

  heartbeat(browserId: string, name: string, enabled: boolean, now = Date.now()): void {
    this.removeExpired(now);
    if (!this.connected.has(browserId) && this.connected.size >= BROWSER_LIMITS.clients) {
      throw new Error('Too many browser connections');
    }
    this.connected.set(browserId, { id: browserId, name: name.slice(0, 80), enabled, seenAt: now });
  }

  clear(): void {
    this.connected.clear();
  }

  private removeExpired(now: number): void {
    for (const [browserId, browser] of this.connected) {
      if (now - browser.seenAt >= BROWSER_LIMITS.presenceMs) this.connected.delete(browserId);
    }
  }
}
