import { DurableStateFiles } from './durable/files.js';
import { DurableWriteCoordinator } from './durable/write-coordinator.js';

const files = new DurableStateFiles();
const writes = new DurableWriteCoordinator(() => files.isReady, (name, value) => files.replace(name, value));

export function initDurableStore(userDataDir: string): void {
  files.initialize(userDataDir);
}

export function readDurable<T>(name: string): Promise<T | null> {
  return files.read<T>(name);
}

export function writeDurableSoon(name: string, value: unknown): void {
  writes.enqueue(name, value);
}

export function writeDurableSnapshotSoon(name: string, snapshot: () => unknown): void {
  writes.enqueueProjection(name, snapshot);
}

export function writeDurableNow(name: string, value: unknown): Promise<void> {
  return writes.commit(name, value);
}

export function flushDurable(): Promise<void> {
  return writes.flush();
}

export function resetDurableForTests(): void {
  writes.reset();
  files.reset();
}
