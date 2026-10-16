const WRITE_DELAY_MS = 300;
const RETRY_MAX_MS = 5_000;

type WritePayload =
  | { kind: 'value'; value: unknown }
  | { kind: 'projection'; read?: () => unknown; captured?: unknown; resolved: boolean };

interface WriteTask {
  revision: number;
  payload: WritePayload;
  debounced: boolean;
  execution?: Promise<void>;
}

export class DurableWriteCoordinator {
  private readonly pending = new Map<string, WriteTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retries = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private revision = 1;

  constructor(private readonly enabled: () => boolean, private readonly persist: (name: string, value: unknown) => Promise<void>) {}

  enqueue(name: string, value: unknown): void {
    if (!this.enabled()) return;
    this.pending.set(name, this.task({ kind: 'value', value }, true));
    this.schedule(name, WRITE_DELAY_MS);
  }

  enqueueProjection(name: string, read: () => unknown): void {
    if (!this.enabled()) return;
    this.pending.set(name, this.task({ kind: 'projection', read, resolved: false }, true));
    this.schedule(name, WRITE_DELAY_MS);
  }

  async commit(name: string, value: unknown): Promise<void> {
    if (!this.enabled()) return;
    this.cancelTimer(name);
    const task = this.task({ kind: 'value', value }, false);
    this.pending.set(name, task);
    try {
      await this.execute(name, task);
    } catch (error) {
      this.retry(name);
      throw error;
    }
  }

  async flush(): Promise<void> {
    for (const name of this.timers.keys()) this.cancelTimer(name);
    for (;;) {
      const queued = [...this.pending.entries()];
      const running = [...this.tails.values()];
      if (queued.length === 0 && running.length === 0) return;
      const results = await Promise.allSettled([
        ...running,
        ...queued.map(([name, task]) => this.execute(name, task))
      ]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }

  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.retries.clear();
    this.tails.clear();
    this.revision = 1;
  }

  private task(payload: WritePayload, debounced: boolean): WriteTask {
    return { revision: this.revision++, payload, debounced };
  }

  private schedule(name: string, delay: number): void {
    if (this.timers.has(name) || !this.pending.has(name)) return;
    const timer = setTimeout(() => {
      this.timers.delete(name);
      const task = this.pending.get(name);
      if (task) void this.execute(name, task).catch(() => this.retry(name));
    }, delay);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private retry(name: string): void {
    if (!this.pending.has(name) || this.timers.has(name)) return;
    const attempt = (this.retries.get(name) ?? 0) + 1;
    this.retries.set(name, attempt);
    const delay = Math.min(RETRY_MAX_MS, WRITE_DELAY_MS * 2 ** Math.min(attempt, 4));
    this.schedule(name, delay);
  }

  private async execute(name: string, task: WriteTask): Promise<void> {
    if (task.execution) return task.execution;
    const previous = this.tails.get(name) ?? Promise.resolve();
    const execution = previous.then(() => this.write(name, task));
    task.execution = execution;
    const tail = execution.then(() => undefined, () => undefined).finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
    this.tails.set(name, tail);
    void execution.then(() => { delete task.execution; }, () => { delete task.execution; });
    return execution;
  }

  private async write(name: string, task: WriteTask): Promise<void> {
    if (task.debounced && this.pending.get(name) !== task) return;
    await this.persist(name, this.resolve(task.payload));
    if (this.pending.get(name)?.revision !== task.revision) return;
    this.pending.delete(name);
    this.retries.delete(name);
  }

  private resolve(payload: WritePayload): unknown {
    if (payload.kind === 'value') return payload.value;
    if (!payload.resolved) {
      payload.captured = payload.read?.();
      payload.resolved = true;
      delete payload.read;
    }
    return payload.captured;
  }

  private cancelTimer(name: string): void {
    const timer = this.timers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(name);
  }
}
