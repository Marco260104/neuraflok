export class TaskRequestError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs?: number) {
    super(message);
  }
}
