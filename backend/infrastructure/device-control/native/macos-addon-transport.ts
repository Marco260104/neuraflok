import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ComputerError } from './errors.js';
import type { ExpectedHelper, PendingHelperRequest } from './transport-contracts.js';
import { protocolFailure } from './transport-protocol.js';

interface AddonRuntime {
  generation: number;
  worker: Worker;
  pending: PendingHelperRequest | null;
  exited: boolean;
}

interface AddonTransportDependencies {
  startupGraceMs: number;
  isStopping: () => boolean;
  nextGeneration: () => number;
  assertGeneration: (generation: number, expected?: ExpectedHelper) => void;
  timeoutForRequest: (request: Record<string, unknown>) => number;
  stampReply: (reply: Record<string, any>, generation: number) => Record<string, any>;
  logWarn: (message: string) => void;
}

const WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { createRequire } = require('node:module');
  try {
    const addon = createRequire(process.execPath)(workerData.addon);
    addon.initialize(workerData.library);
    parentPort.postMessage({ type: 'ready' });
    parentPort.on('message', ({ request }) => {
      try {
        const reply = JSON.parse(addon.handle(JSON.stringify(request)));
        parentPort.postMessage({ type: 'reply', reply });
      } catch (error) {
        parentPort.postMessage({ type: 'failure', message: error instanceof Error ? error.message : String(error) });
      }
    });
  } catch (error) {
    parentPort.postMessage({ type: 'failure', message: error instanceof Error ? error.message : String(error) });
  }
`;

export function usesMacOSAddon(): boolean {
  return process.platform === 'darwin' && !process.env['NEURAFLOK_MACOS_DESKTOP_HELPER'];
}

function locateMacOSAddon(): { addon: string; library: string } {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const explicitAddon = process.env['NEURAFLOK_DESKTOP_ADDON'];
  const explicitLibrary = process.env['NEURAFLOK_MACOS_DESKTOP_LIBRARY'];
  const candidates = [
    explicitAddon && explicitLibrary ? { addon: explicitAddon, library: explicitLibrary } : null,
    resourcesPath
      ? {
          addon: path.join(resourcesPath, 'desktop', 'macos-desktop-addon.node'),
          library: path.join(resourcesPath, 'desktop', 'libneuraflok-desktop.dylib')
        }
      : null,
    {
      addon: path.resolve(process.cwd(), 'resources', 'packaging', 'desktop', 'darwin', process.arch, 'macos-desktop-addon.node'),
      library: path.resolve(process.cwd(), 'resources', 'packaging', 'desktop', 'darwin', process.arch, 'libneuraflok-desktop.dylib')
    }
  ].filter((candidate): candidate is { addon: string; library: string } => candidate !== null);
  const found = candidates.find(candidate => existsSync(candidate.addon) && existsSync(candidate.library));
  if (found) return found;
  throw new ComputerError(
    `The in-process macOS desktop backend is missing for ${process.arch}. Run npm run desktop:mac before development, or rebuild the macOS package.`
  );
}

export function createMacOSAddonTransport(dependencies: AddonTransportDependencies) {
  let runtime: AddonRuntime | null = null;
  let starting: Promise<AddonRuntime> | null = null;

  async function retire(target: AddonRuntime): Promise<void> {
    if (runtime === target) runtime = null;
    target.exited = true;
    await target.worker.terminate().then(() => undefined, () => undefined);
  }

  async function start(): Promise<AddonRuntime> {
    if (dependencies.isStopping()) throw new ComputerError('The desktop helper is shutting down.');
    if (runtime && !runtime.exited) return runtime;
    if (starting) return starting;
    const payload = locateMacOSAddon();
    starting = new Promise<AddonRuntime>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: payload });
      const target: AddonRuntime = { worker, pending: null, exited: false, generation: 0 };
      let initialized = false;
      const startupTimer = setTimeout(() => {
        if (initialized) return;
        void retire(target);
        reject(new ComputerError('The macOS Desktop addon did not initialize in time.'));
      }, dependencies.startupGraceMs);
      worker.on('message', (message: { type?: string; reply?: unknown; message?: string }) => {
        if (message.type === 'ready' && !initialized) {
          initialized = true;
          clearTimeout(startupTimer);
          runtime = target;
          target.generation = dependencies.nextGeneration();
          resolve(target);
          return;
        }
        if (message.type === 'failure') {
          const error = new ComputerError(`macOS Desktop addon failed: ${message.message ?? 'unknown failure'}`);
          if (!initialized) {
            clearTimeout(startupTimer);
            reject(error);
          }
          const pending = target.pending;
          target.pending = null;
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          void retire(target);
          return;
        }
        if (message.type !== 'reply') return;
        const pending = target.pending;
        target.pending = null;
        if (!pending) {
          dependencies.logWarn('macOS Desktop addon sent an unsolicited reply');
          return;
        }
        clearTimeout(pending.timer);
        const reply = message.reply;
        if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
          pending.reject(new ComputerError('The macOS Desktop addon returned a malformed protocol response.'));
          return;
        }
        const record = reply as Record<string, any>;
        const failure = protocolFailure(record);
        if (failure) pending.reject(failure);
        else pending.resolve(dependencies.stampReply(record, target.generation));
      });
      worker.once('error', error => {
        if (!initialized) {
          clearTimeout(startupTimer);
          reject(new ComputerError(`Could not start the macOS Desktop addon: ${error.message}`));
        }
        const pending = target.pending;
        target.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new ComputerError(`macOS Desktop addon error: ${error.message}`));
        }
      });
      worker.once('exit', () => {
        target.exited = true;
        if (runtime === target) runtime = null;
        if (!initialized) {
          clearTimeout(startupTimer);
          reject(new ComputerError('The macOS Desktop addon exited during startup.'));
        }
        const pending = target.pending;
        target.pending = null;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new ComputerError('The macOS Desktop addon exited before answering.'));
        }
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function send(request: Record<string, unknown>, expected?: ExpectedHelper): Promise<Record<string, any>> {
    const active = await start();
    dependencies.assertGeneration(active.generation, expected);
    if (active.pending) throw new ComputerError('macOS Desktop addon received overlapping requests.');
    return new Promise((resolve, reject) => {
      let pending: PendingHelperRequest;
      const timer = setTimeout(() => {
        if (active.pending !== pending) return;
        active.pending = null;
        void retire(active).then(() => reject(new ComputerError('The macOS Desktop addon did not answer in time.')));
      }, dependencies.timeoutForRequest(request));
      pending = { resolve, reject, timer };
      active.pending = pending;
      active.worker.postMessage({ request });
    });
  }

  async function stop(): Promise<void> {
    const pendingStart = starting;
    if (pendingStart) await pendingStart.catch(() => null);
    const active = runtime;
    runtime = null;
    starting = null;
    if (!active) return;
    const pending = active.pending;
    active.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerError('The desktop helper was stopped because the app is shutting down.'));
    }
    await retire(active);
  }

  function isActive(generation: number): boolean {
    return runtime !== null && !runtime.exited && runtime.generation === generation;
  }

  return { isActive, send, stop };
}
