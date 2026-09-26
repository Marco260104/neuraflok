import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ensureUsablePath, normalizeEnvironment } from '../../settings/env.js';
import { findWindowsPowerShell, terminateProcessTree } from '../../../domains/workspace/exec.js';
import { ComputerError } from './errors.js';
import { HELPER_SCRIPT } from './helper.js';
import { protocolFailure } from './transport-protocol.js';
import type { ExpectedHelper, PendingHelperRequest } from './transport-contracts.js';

interface HelperRuntime {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrTail: string;
  pending: PendingHelperRequest | null;
  ready: boolean;
  scriptDirectory: string | null;
  scriptCleanup: Promise<void> | null;
}

interface ProcessHelperTransportDependencies {
  startupGraceMs: number;
  isStopping: () => boolean;
  nextGeneration: () => number;
  assertGeneration: (generation: number, expected?: ExpectedHelper) => void;
  timeoutForRequest: (request: Record<string, unknown>) => number;
  stampReply: (reply: Record<string, any>, generation: number) => Record<string, any>;
  logWarn: (message: string) => void;
}

export function createProcessHelperTransport(dependencies: ProcessHelperTransportDependencies) {
  let runtime: HelperRuntime | null = null;
  let starting: Promise<HelperRuntime> | null = null;
  const retirements = new Set<Promise<void>>();

  function cleanupHelperScript(target: HelperRuntime): Promise<void> {
    return target.scriptCleanup ??= (async () => {
      if (!target.scriptDirectory) return;
      const directory = target.scriptDirectory;
      target.scriptDirectory = null;
      await fs.rm(directory, { recursive: true, force: true }).catch(error => {
        dependencies.logWarn(`desktop helper script cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    })();
  }

  function retire(target: HelperRuntime): Promise<void> {
    if (runtime === target) runtime = null;
    const task = (async () => {
      if (target.child.exitCode === null && target.child.pid !== undefined) {
        const closed = new Promise<void>(resolve => target.child.once('close', () => resolve()));
        await terminateProcessTree(target.child.pid);
        await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
      }
      await cleanupHelperScript(target);
    })();
    retirements.add(task);
    void task.finally(() => retirements.delete(task));
    return task;
  }

  function readableFailure(stderr: string): string {
    const clean = stderr
      .replace(/^#< CLIXML[\s\S]*/m, '')
      .trim()
      .split(/\r?\n/)
      .find(line => line.trim().length > 0);
    return clean?.slice(0, 300) ?? 'the helper process exited unexpectedly';
  }

  function rejectAfterRetirement(target: HelperRuntime, pending: PendingHelperRequest, error: ComputerError): void {
    clearTimeout(pending.timer);
    if (target.pending === pending) target.pending = null;
    void retire(target).then(
      () => pending.reject(error),
      () => pending.reject(error)
    );
  }

  async function start(): Promise<HelperRuntime> {
    if (dependencies.isStopping()) throw new ComputerError('The desktop helper is shutting down.');
    if (runtime) return runtime;
    if (starting) return starting;

    starting = (async () => {
      const scriptDirectory = process.platform === 'darwin' ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'neuraflok-desktop-helper-'));
      try {
        const scriptFile = scriptDirectory ? path.join(scriptDirectory, 'helper.ps1') : null;
        if (scriptFile) await fs.writeFile(scriptFile, `\uFEFF${HELPER_SCRIPT}`, 'utf8');
        if (dependencies.isStopping()) throw new ComputerError('The desktop helper is shutting down.');
        return await new Promise<HelperRuntime>((resolve, reject) => {
          const env = normalizeEnvironment(process.env);
          ensureUsablePath(env);
          let host: string;
          let args: string[];
          if (process.platform === 'darwin') {
            host = locateMacOSDesktopHelper();
            args = [];
          } else {
            host = findWindowsPowerShell() ?? 'powershell.exe';
            env.NEURAFLOK_APP_PID = String(process.pid);
            args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptFile!];
          }
          const child = spawn(host, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: env as NodeJS.ProcessEnv
          });
          const target: HelperRuntime = {
            generation: 0,
            child,
            stdoutBuffer: '',
            stderrTail: '',
            pending: null,
            ready: false,
            scriptDirectory,
            scriptCleanup: null
          };
          let started = false;
          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');

          child.stdout.on('data', (chunk: Buffer) => {
            target.stdoutBuffer += stdoutDecoder.write(chunk);
            for (;;) {
              const newline = target.stdoutBuffer.indexOf('\n');
              if (newline === -1) break;
              const line = target.stdoutBuffer.slice(0, newline).trim();
              target.stdoutBuffer = target.stdoutBuffer.slice(newline + 1);
              if (!line) continue;
              const pending = target.pending;
              if (!pending) {
                dependencies.logWarn(`desktop helper sent unsolicited output: ${line.slice(0, 200)}`);
                continue;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(line) as unknown;
              } catch {
                rejectAfterRetirement(target, pending, new ComputerError('The desktop helper returned malformed JSON.'));
                continue;
              }
              if (
                parsed === null ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed) ||
                (((parsed as Record<string, unknown>)['ok'] !== true) && (parsed as Record<string, unknown>)['ok'] !== false)
              ) {
                rejectAfterRetirement(target, pending, new ComputerError('The desktop helper returned a malformed protocol response.'));
                continue;
              }
              const reply = parsed as Record<string, any>;
              target.ready = true;
              clearTimeout(pending.timer);
              target.pending = null;
              if (reply['ok'] === false) pending.reject(protocolFailure(reply)!);
              else pending.resolve(dependencies.stampReply(reply, target.generation));
            }
          });
          child.stderr.on('data', (chunk: Buffer) => {
            target.stderrTail = `${target.stderrTail}${stderrDecoder.write(chunk)}`.slice(-8000);
          });
          child.once('spawn', () => {
            started = true;
            runtime = target;
            target.generation = dependencies.nextGeneration();
            resolve(target);
          });
          child.once('error', error => {
            if (runtime === target) runtime = null;
            if (!started) {
              reject(new ComputerError(`Could not start the desktop helper: ${error.message}`));
              return;
            }
            const pending = target.pending;
            if (pending) {
              rejectAfterRetirement(target, pending, new ComputerError(`Desktop helper process error: ${error.message}`));
            } else {
              void retire(target);
            }
          });
          child.once('close', () => {
            if (runtime === target) runtime = null;
            void cleanupHelperScript(target);
            const pending = target.pending;
            if (pending) {
              clearTimeout(pending.timer);
              target.pending = null;
              pending.reject(new ComputerError(`Desktop helper failed: ${readableFailure(target.stderrTail)}`));
            }
          });
        });
      } catch (error) {
        if (scriptDirectory) await fs.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    })().finally(() => {
      starting = null;
    });

    return starting;
  }

  async function send(request: Record<string, unknown>, expected?: ExpectedHelper): Promise<Record<string, any>> {
    const active = await start();
    dependencies.assertGeneration(active.generation, expected);
    if (active.pending) throw new ComputerError('Desktop helper received overlapping requests.');

    return new Promise<Record<string, any>>((resolve, reject) => {
      let pending: PendingHelperRequest;
      const timer = setTimeout(() => {
        if (active.pending !== pending) return;
        rejectAfterRetirement(active, pending, new ComputerError('The desktop helper did not answer in time.'));
      }, dependencies.timeoutForRequest(request) + (active.ready ? 0 : dependencies.startupGraceMs));
      pending = { resolve, reject, timer };
      active.pending = pending;
      active.child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', error => {
        if (!error || active.pending !== pending) return;
        rejectAfterRetirement(active, pending, new ComputerError(`Could not send a desktop helper request: ${error.message}`));
      });
    });
  }

  async function waitForStartup(): Promise<void> {
    const pendingStart = starting;
    if (pendingStart) await pendingStart.catch(() => null);
  }

  async function stop(): Promise<void> {
    await waitForStartup();
    const active = runtime;
    runtime = null;
    starting = null;
    if (!active) {
      await Promise.allSettled([...retirements]);
      return;
    }

    const pending = active.pending;
    active.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerError('The desktop helper was stopped because the app is shutting down.'));
    }
    try {
      active.child.stdin.end();
    } catch {
      // The helper may already have closed its pipe.
    }
    await retire(active);
    await Promise.allSettled([...retirements]);
  }

  function isActive(generation: number): boolean {
    return runtime !== null && runtime.child.exitCode === null && runtime.generation === generation;
  }

  return { isActive, send, stop, waitForStartup };
}

function locateMacOSDesktopHelper(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env['NEURAFLOK_MACOS_DESKTOP_HELPER'],
    resourcesPath ? path.join(resourcesPath, 'desktop', 'macos-desktop-helper') : null,
    path.resolve(process.cwd(), 'resources', 'packaging', 'desktop', 'darwin', process.arch, 'macos-desktop-helper')
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  const helper = candidates.find(candidate => existsSync(candidate));
  if (helper) return helper;
  throw new ComputerError(
    `The macOS desktop helper is missing for ${process.arch}. Run npm run desktop:mac before development, or rebuild the macOS package.`
  );
}
