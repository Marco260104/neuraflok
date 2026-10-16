import type { BrowserResult } from '../../../../contracts/browser/control-policy.js';
import type { PendingBrowserRequest } from './types.js';

export class PendingBrowserRequests {
  private readonly entries = new Map<string, PendingBrowserRequest>();

  get size(): number {
    return this.entries.size;
  }

  get(requestId: string): PendingBrowserRequest | undefined {
    return this.entries.get(requestId);
  }

  add(requestId: string, request: PendingBrowserRequest): void {
    this.entries.set(requestId, request);
  }

  availableFor(browserId: string): string[] {
    return [...this.entries]
      .filter(([, request]) => request.browserId === browserId && !request.claimed && !request.claiming)
      .map(([requestId]) => requestId);
  }

  complete(requestId: string, result: BrowserResult): boolean {
    const request = this.entries.get(requestId);
    if (!request) return false;
    this.entries.delete(requestId);
    if (request.timer) clearTimeout(request.timer);
    request.resolve(result);
    return true;
  }

  completeAll(resultFor: (request: PendingBrowserRequest) => BrowserResult): void {
    for (const [requestId, request] of this.entries) this.complete(requestId, resultFor(request));
  }
}
