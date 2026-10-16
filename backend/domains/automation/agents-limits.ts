// Maximum unread messages retained per agent before the broker refuses more work.
export const MAX_QUEUE = 200;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_INBOX_OFFER_CHARS = 32_000;
export const MAX_BATCH_MESSAGES = 16;
export const MAX_TASK_CHARS = 4000;
export const MAX_CONTEXT_CHARS = 4000;
export const MAX_LABEL_CHARS = 60;

/** Real work renews this deadline; an open page, reload or status poll does not. */
export const WORKER_SILENCE_MS = 3 * 60_000;

// Fresh provider-page generation evidence can defer the worker silence check.
export const PAGE_GENERATING_FRESH_MS = 150_000;

// Bound idle provider turns so missing progress cannot keep a worker alive indefinitely.
export const WORKER_THINKING_MAX_MS = 2 * 60 * 60_000;

// Number of consecutive failed wakes that end a worker.
export const WAKE_FAILURES_BEFORE_GIVING_UP = 2;

// Maximum dormant families retained for inactive prime conversations.
export const MAX_DORMANT_RUNS = 16;
export const DORMANT_RUN_TTL_MS = 7 * 24 * 60 * 60_000;
export const RETIRED_WORKER_TTL_MS = 30 * 60_000;
