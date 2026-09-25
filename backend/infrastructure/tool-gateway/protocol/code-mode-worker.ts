import { WINDOWS_COMPUTER_METHODS } from '../../../../contracts/windows-computer/operation-policy.js';
import { WORKER_BRIDGE_SOURCE } from './code-mode-worker/bridge-source.js';
import { WORKER_EVENT_LOOP_SOURCE } from './code-mode-worker/event-loop-source.js';
import { WORKER_SHELL_SOURCE } from './code-mode-worker/shell-source.js';
import { buildWorkerSandboxSource } from './code-mode-worker/sandbox-source.js';

/** Trusted worker bootstrap; model code runs only inside the bounded QuickJS WASM heap. */
export const CODE_MODE_WORKER_SOURCE = [
  WORKER_SHELL_SOURCE,
  WORKER_BRIDGE_SOURCE,
  buildWorkerSandboxSource(WINDOWS_COMPUTER_METHODS),
  WORKER_EVENT_LOOP_SOURCE
].join('\n');
