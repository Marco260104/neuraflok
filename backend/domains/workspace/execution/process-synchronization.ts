export interface SignalWait {
  promise: Promise<void>;
  dispose(): void;
}

export class ProcessSignal {
  private version = 0;
  private readonly waiters = new Set<() => void>();

  currentVersion(): number {
    return this.version;
  }

  notified(afterVersion = this.version): SignalWait {
    let active = true;
    let resolveWaiter!: () => void;
    const promise = new Promise<void>(resolve => { resolveWaiter = resolve; });
    const settle = () => {
      if (!active) return;
      active = false;
      this.waiters.delete(settle);
      resolveWaiter();
    };
    if (afterVersion === this.version) this.waiters.add(settle);
    else settle();
    return {
      promise,
      dispose: () => {
        if (!active) return;
        active = false;
        this.waiters.delete(settle);
      }
    };
  }

  notifyAll(): void {
    this.version++;
    for (const settle of [...this.waiters]) settle();
  }
}

export class AsyncMutex {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  lock(): Promise<() => void> {
    return new Promise(resolve => {
      const grant = () => {
        this.locked = true;
        resolve(this.createRelease());
      };
      if (this.locked || this.queue.length > 0) this.queue.push(grant);
      else grant();
    });
  }

  tryLock(): (() => void) | null {
    if (this.locked || this.queue.length > 0) return null;
    this.locked = true;
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}
