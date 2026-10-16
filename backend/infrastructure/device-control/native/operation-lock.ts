import { logInfo } from '../../settings/logger.js';

type PendingOperation = {
  task: () => Promise<unknown>;
  queuedAt: number;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

const pendingOperations: PendingOperation[] = [];
let operationRunning = false;

export function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    pendingOperations.push({
      task,
      queuedAt,
      resolve: value => resolve(value as T),
      reject
    });
    startNextOperation();
  });
}

function startNextOperation(): void {
  if (operationRunning) return;
  const next = pendingOperations.shift();
  if (!next) return;
  operationRunning = true;
  const startedAt = Date.now();
  void finishOperation(next, startedAt);
}

async function finishOperation(operation: PendingOperation, startedAt: number): Promise<void> {
  let value: unknown;
  let failure: unknown;
  let rejected = false;
  try {
    value = await operation.task();
  } catch (error) {
    rejected = true;
    failure = error;
  }
  try {
    logInfo(`desktop timing exclusive_queue_ms=${startedAt - operation.queuedAt} exclusive_ms=${Date.now() - startedAt}`);
  } catch (error) {
    rejected = true;
    failure = error;
  }
  if (rejected) operation.reject(failure);
  else operation.resolve(value);
  operationRunning = false;
  startNextOperation();
}
