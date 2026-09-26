import type { TaskProgressUpdate } from '../../../../contracts/automation/task-progress.js';
import { retryTaskRequest } from './retry.js';

const MAX_TRACKED_REQUESTS = 64;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WINDOW_MS = 180_000;

interface TrackedRequest {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<unknown>;
  settled: boolean;
}

const requests = new Map<string, TrackedRequest>();

export function cancelTaskRequest(id: string): boolean {
  const request = requests.get(id);
  if (!request || request.settled) return false;
  request.controller.abort();
  return true;
}

function clearSettledRequests(): void {
  for (const [id, request] of requests) {
    if (requests.size < MAX_TRACKED_REQUESTS) break;
    if (request.settled) requests.delete(id);
  }
}

export function runTaskRequest<T>(
  id: string,
  fingerprint: string,
  work: (signal: AbortSignal) => Promise<T>,
  publish: (progress: TaskProgressUpdate) => void
): Promise<T> {
  const existing = requests.get(id);
  if (existing) {
    return existing.fingerprint === fingerprint
      ? existing.promise as Promise<T>
      : Promise.reject(new Error('task_request_conflict'));
  }
  clearSettledRequests();
  if (requests.size >= MAX_TRACKED_REQUESTS) return Promise.reject(new Error('too_many_task_requests'));

  const controller = new AbortController();
  const request: TrackedRequest = { fingerprint, controller, promise: Promise.resolve(), settled: false };
  requests.set(id, request);
  request.promise = (async () => {
    try {
      return await retryTaskRequest(work, controller.signal, publish, {
        attempts: MAX_ATTEMPTS,
        durationMs: MAX_RETRY_WINDOW_MS
      });
    } catch (error) {
      publish({
        phase: controller.signal.aborted ? 'cancelled' : 'failed',
        text: '',
        error: error instanceof Error ? error.message : 'task_failed'
      });
      if (controller.signal.aborted) throw new Error('task_cancelled');
      throw error;
    } finally {
      request.settled = true;
    }
  })();
  return request.promise as Promise<T>;
}
