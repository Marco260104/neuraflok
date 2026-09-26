// Keeps the integrated extension worker alive and delivers queued browser events after startup.

import { ExtensionAlarms } from './extension-alarms.js';

export interface WorkerLike {
  readonly scope: string;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  startTask(): { end(): void };
  readonly ipc: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
  };
}

export interface WorkerRegistry {
  getWorkerFromVersionID(versionId: number): WorkerLike | undefined;
  getAllRunning(): Record<number, unknown>;
  startWorkerForScope(scope: string): Promise<unknown>;
}

export type WorkerStatus = 'starting' | 'running' | 'stopping' | 'stopped';

export const EVENT_CHANNEL = 'integrated-browser:event';
export const API_CHANNEL = 'integrated-browser:api';
// Bound events waiting for a worker so a failed restart cannot grow memory without limit.
export const PENDING_EVENT_LIMIT = 1000;
const WAKE_RETRY_MS = 1000;

export class ExtensionWorkerLink {
  private readonly workers = new Map<number, WorkerLike>();
  private readonly ready = new Set<number>();
  private readonly keepAlive = new Map<number, { end(): void }>();
  private readonly pending: Array<[string, unknown[]]> = [];
  private dropped = 0;
  private closed = false;
  private readonly alarms = new ExtensionAlarms(alarm => this.send('alarms.onAlarm', [alarm]));

  constructor(
    private readonly registry: WorkerRegistry,
    // Link only the worker for this extension scope.
    private readonly scope: string,
    private readonly answer: (name: string, args: unknown) => Promise<unknown>,
    private readonly warn: (message: string) => void
  ) {
    for (const versionId of Object.keys(registry.getAllRunning())) this.statusChanged(Number(versionId), 'running');
  }

  statusChanged(versionId: number, status: WorkerStatus): void {
    if (this.closed) return;
    if (status === 'starting' || status === 'running') { this.attach(versionId, status === 'running'); return; }
    // A stopping worker takes no more events; it stays linked until it has stopped.
    this.ready.delete(versionId);
    this.keepAlive.delete(versionId);
    if (status === 'stopping') return;
    // A running browser keeps its extension running.
    if (this.workers.delete(versionId)) this.wake();
  }

  // Deliver an event now or when a worker becomes ready.
  send(name: string, args: unknown[]): void {
    if (this.closed) return;
    const live = this.live();
    if (live.length > 0 && this.pending.length === 0) {
      for (const worker of live) worker.send(EVENT_CHANNEL, name, args);
      return;
    }
    if (this.pending.length < PENDING_EVENT_LIMIT) this.pending.push([name, args]);
    else if (this.dropped++ === 0) this.warn(`integrated browser: the extension worker is not taking events; dropping ${name} and later ones until it does`);
    if (this.workers.size === 0) this.wake();
  }

  // Release worker tasks and pending events when the browser stops.
  close(): void {
    this.closed = true;
    this.alarms.close();
    for (const task of this.keepAlive.values()) {
      try { task.end(); } catch {}
    }
    this.keepAlive.clear();
    this.workers.clear();
    this.ready.clear();
    this.pending.length = 0;
  }

  private attach(versionId: number, running: boolean): void {
    const worker = this.registry.getWorkerFromVersionID(versionId);
    if (!worker || worker.isDestroyed() || worker.scope !== this.scope) return;
    if (this.workers.get(versionId) !== worker) {
      this.workers.set(versionId, worker);
      // A worker that outlived an earlier link still holds that link's handler.
      worker.ipc.removeHandler(API_CHANNEL);
      worker.ipc.handle(API_CHANNEL, async (_event, name, args) => {
        if (String(name).startsWith('alarms.')) {
          try {
            if (this.closed) throw new Error('The browser is stopped.');
            if (!Array.isArray(args)) throw new Error('Alarm arguments must be an array.');
            return { ok: true, value: this.alarms.call(String(name), args) };
          } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
        }
        return this.answer(String(name), args);
      });
    }
    if (!running) return;
    if (!this.keepAlive.has(versionId)) {
      try { this.keepAlive.set(versionId, worker.startTask()); }
      catch (error) { this.warn(`integrated browser: could not keep the extension worker alive: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.ready.add(versionId);
    this.flush();
  }

  private live(): WorkerLike[] {
    return [...this.workers].filter(([id, worker]) => this.ready.has(id) && !worker.isDestroyed()).map(([, worker]) => worker);
  }

  private flush(): void {
    const live = this.live();
    if (live.length === 0 || this.pending.length === 0) return;
    if (this.dropped > 0) { this.warn(`integrated browser: the extension worker is back; ${this.dropped} event(s) were dropped meanwhile`); this.dropped = 0; }
    for (const [name, args] of this.pending.splice(0)) for (const worker of live) worker.send(EVENT_CHANNEL, name, args);
  }

  // Retry once when a worker start races Electron's own startup.
  private wake(retried = false): void {
    void this.registry.startWorkerForScope(this.scope).catch(error => {
      if (this.closed || this.workers.size > 0) return;
      if (!retried) { setTimeout(() => { if (!this.closed && this.workers.size === 0) this.wake(true); }, WAKE_RETRY_MS); return; }
      this.warn(`integrated browser: could not start the extension worker: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
