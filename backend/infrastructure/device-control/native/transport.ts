import { logInfo, logWarn } from '../../settings/logger.js';
import { ComputerError } from './errors.js';
import { createMacOSAddonTransport, usesMacOSAddon } from './macos-addon-transport.js';
import { createProcessHelperTransport } from './process-helper-transport.js';
import type { ExpectedHelper } from './transport-contracts.js';

export type { ExpectedHelper } from './transport-contracts.js';

const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STARTUP_GRACE_MS = 10_000;

let helperQueue: Promise<void> = Promise.resolve();
let helperGeneration = 0;
let helperStopping = false;

export function currentHelperGeneration(): number {
  return helperGeneration;
}

const helperReplyGeneration = new WeakMap<object, number>();

function stampHelperReply(reply: Record<string, any>, generation: number): Record<string, any> {
  helperReplyGeneration.set(reply, generation);
  return reply;
}

export function generationOfReply(reply: Record<string, any>): number {
  const generation = helperReplyGeneration.get(reply);
  if (generation === undefined) throw new ComputerError('Desktop reply has no transport identity.');
  return generation;
}

export function isHelperGenerationActive(generation: number): boolean {
  if (helperStopping) return false;
  return usesMacOSAddon()
    ? macOSAddonTransport.isActive(generation)
    : processHelperTransport.isActive(generation);
}

export function assertHelperGeneration(generation: number, expected?: ExpectedHelper): void {
  if (helperStopping) throw new ComputerError('The desktop helper is shutting down.');
  if (expected && (generation !== expected.generation || !isHelperGenerationActive(generation))) {
    throw new ComputerError(`${expected.code}: the desktop helper changed. Observe again before retrying.`, {
      completedCount: 0, failedIndex: 0, completedRoutes: []
    });
  }
}

export function helperTimeoutMs(
  request: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform
): number {
  switch (request['op']) {
    case 'windows':
    case 'active':
    case 'focus':
    case 'cursor':
      return 5_000;
    case 'find_ui':
      return 8_000;
    case 'capture':
    case 'snapshot':
      return platform === 'darwin' ? 120_000 : 10_000;
    case 'warm':
      return 10_000;
    case 'act':
      if (platform !== 'darwin') {
        const actions = Array.isArray(request['actions']) ? request['actions'].slice(0, 20) : [];
        return 15_000 + actions.reduce((duration, action) => duration + (action?.type === 'drag'
          ? Math.min(2000, Math.max(50, Number(action.durationMs) || 350)) : 0), 0);
      }
      return 15_000 + Math.min(20, Array.isArray(request['actions']) ? request['actions'].length : 1) * 2_100;
    default:
      return HELPER_TIMEOUT_MS;
  }
}

const transportDependencies = {
  startupGraceMs: HELPER_STARTUP_GRACE_MS,
  isStopping: () => helperStopping,
  nextGeneration: () => ++helperGeneration,
  assertGeneration: assertHelperGeneration,
  timeoutForRequest: (request: Record<string, unknown>) => helperTimeoutMs(request),
  stampReply: stampHelperReply,
  logWarn
};

const macOSAddonTransport = createMacOSAddonTransport(transportDependencies);
const processHelperTransport = createProcessHelperTransport(transportDependencies);

export async function stopNativeTransport(): Promise<void> {
  helperStopping = true;
  await processHelperTransport.waitForStartup();
  await macOSAddonTransport.stop();
  await processHelperTransport.stop();
}

async function sendHelperRequest(request: Record<string, unknown>, expected?: ExpectedHelper): Promise<Record<string, any>> {
  return usesMacOSAddon()
    ? macOSAddonTransport.send(request, expected)
    : processHelperTransport.send(request, expected);
}

export function runHelper(request: Record<string, unknown>, expected?: ExpectedHelper): Promise<Record<string, any>> {
  const queuedAt = Date.now();
  const operation = typeof request['op'] === 'string' ? request['op'] : 'unknown';
  const result = helperQueue.then(async () => {
    const startedAt = Date.now();
    try {
      return await sendHelperRequest(request, expected);
    } finally {
      logInfo(
        `desktop timing op=${operation} helper_queue_ms=${startedAt - queuedAt} helper_ms=${Date.now() - startedAt}`
      );
    }
  });
  helperQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
