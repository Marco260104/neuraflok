import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { browserPreferencePatchSchema, browserPreferencesSchema, type BrowserPreferences } from '../../../../contracts/browser/preferences.js';
import { wakeBrowserWork } from '../browser-wake.js';

const REQUEST_TIMEOUT_MS = 65_000;
const acknowledgementSchema = z.object({
  nonce: z.string().uuid(),
  values: browserPreferencesSchema.nullable(),
  error: z.string().max(160).optional()
}).strict();

interface PreferenceRequest {
  nonce: string;
  expiresAt: number;
  patch: Partial<BrowserPreferences>;
}

interface PendingPreferenceRequest {
  request: PreferenceRequest;
  resolve(value: BrowserPreferences): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class BrowserPreferenceHandshake {
  private pending: PendingPreferenceRequest | null = null;

  request(raw: unknown): Promise<BrowserPreferences> {
    const patch = browserPreferencePatchSchema.parse(raw);
    if (this.pending) return Promise.reject(new Error('A browser preference request is already pending'));
    return new Promise((resolve, reject) => {
      const request: PreferenceRequest = { nonce: randomUUID(), expiresAt: Date.now() + REQUEST_TIMEOUT_MS, patch };
      const pending: PendingPreferenceRequest = {
        request,
        resolve,
        reject,
        timer: setTimeout(() => this.expire(pending), REQUEST_TIMEOUT_MS)
      };
      pending.timer.unref?.();
      this.pending = pending;
      try {
        wakeBrowserWork();
      } catch (error) {
        this.settle(pending, () => reject(error));
      }
    });
  }

  current(): PreferenceRequest | null {
    const request = this.pending?.request;
    return request && request.expiresAt > Date.now() ? structuredClone(request) : null;
  }

  acknowledge(raw: unknown): boolean {
    const parsed = acknowledgementSchema.safeParse(raw);
    const pending = this.pending;
    if (!parsed.success || !pending || parsed.data.nonce !== pending.request.nonce || Date.now() >= pending.request.expiresAt) return false;
    if (parsed.data.values) this.settle(pending, () => pending.resolve(parsed.data.values!));
    else this.settle(pending, () => pending.reject(new Error(parsed.data.error || 'The extension could not confirm this change. Refresh its preferences.')));
    return true;
  }

  reset(): void {
    const pending = this.pending;
    if (pending) this.settle(pending, () => pending.reject(new Error('Preference request cancelled')));
  }

  private expire(pending: PendingPreferenceRequest): void {
    this.settle(pending, () => pending.reject(new Error('Browser did not confirm its preferences. Connect the extension and refresh.')));
  }

  private settle(pending: PendingPreferenceRequest, complete: () => void): void {
    if (this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    complete();
  }
}

const browserPreferenceHandshake = new BrowserPreferenceHandshake();

export function requestBrowserPreferences(raw: unknown): Promise<BrowserPreferences> {
  return browserPreferenceHandshake.request(raw);
}

export function pendingBrowserPreferenceRequest(): PreferenceRequest | null {
  return browserPreferenceHandshake.current();
}

export function acknowledgeBrowserPreferences(raw: unknown): boolean {
  return browserPreferenceHandshake.acknowledge(raw);
}

export function resetBrowserPreferencesForTests(): void {
  browserPreferenceHandshake.reset();
}
