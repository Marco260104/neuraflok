import type { TaskProgressUpdate } from '../../../../contracts/automation/task-progress.js';
import { TaskRequestError } from './errors.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  let remaining = delayMs;
  while (remaining > 0) {
    const interval = Math.min(remaining, MAX_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('task_cancelled'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, interval);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    remaining -= interval;
  }
}

export async function retryTaskRequest<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  publish: (progress: TaskProgressUpdate) => void,
  limits: { attempts: number; durationMs: number } = { attempts: Infinity, durationMs: Infinity }
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      const value = await work(signal);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TaskRequestError) || !error.retryable) throw error;
      const delayMs = Math.max(1000, error.retryAfterMs ?? 15000);
      if (attempt >= limits.attempts || Date.now() + delayMs - startedAt > limits.durationMs) throw error;
      publish({ phase: 'retrying', text: '', error: error.message, attempt: attempt + 1, retryAt: Date.now() + delayMs });
      await waitForRetry(delayMs, signal);
    }
  }
}
