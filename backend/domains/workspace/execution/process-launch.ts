import { spawn, type ChildProcess } from 'node:child_process';
import { terminateProcessTree } from '../exec.js';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, INTERRUPT } from './unified-exec-constants.js';
import { UnifiedExecError } from './process-errors.js';
import type { ShellType } from './shell.js';

interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

export interface SpawnParams {
  batchMarker?: string;
  command: string[];
  shellType: ShellType;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
}

export interface ProcessTransport {
  readonly pid: number;
  readonly started: boolean;
  write(data: string): void;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
}

export interface ProcessCallbacks {
  output(chunk: Buffer): void;
  exited(exitCode: number | null): void;
  outputClosed(): void;
  failed(message: string): void;
}

let ptyModule: Promise<PtyModule | null> | null = null;

async function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty')
    .then(module => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyModule;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}

function quoteCommandArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

function createPtyTransport(handle: PtyProcess): ProcessTransport {
  return {
    get pid() { return handle.pid; },
    started: true,
    write: data => handle.write(data),
    async interrupt() { handle.write(INTERRUPT); },
    async terminate() {
      try { handle.kill(); } catch {}
      if (handle.pid > 0) await terminateProcessTree(handle.pid, true);
    }
  };
}

function createPipeTransport(child: ChildProcess): ProcessTransport {
  return {
    get pid() { return child.pid ?? -1; },
    started: child.pid !== undefined,
    write() { throw UnifiedExecError.writeToStdin(); },
    async interrupt() {
      if (child.pid === undefined) throw new Error('the process is no longer running');
      if (process.platform === 'win32') await terminateProcessTree(child.pid, true);
      else process.kill(-child.pid, 'SIGINT');
    },
    async terminate() {
      if (child.pid !== undefined) await terminateProcessTree(child.pid, true);
    }
  };
}

export async function launchProcess(params: SpawnParams, callbacks: ProcessCallbacks): Promise<ProcessTransport> {
  const file = params.command[0];
  if (!file || params.command.length === 0) throw UnifiedExecError.missingCommandLine();
  const args = params.command.slice(1);
  if (params.tty) return launchPty(params, callbacks, file, args);
  return launchPipe(params, callbacks, file, args);
}

async function launchPty(
  params: SpawnParams,
  callbacks: ProcessCallbacks,
  file: string,
  args: string[]
): Promise<ProcessTransport> {
  const pty = await loadPty();
  if (!pty) throw UnifiedExecError.createProcess('a pseudo-console is not available on this machine');
  let handle: PtyProcess;
  try {
    const command = params.shellType === 'cmd' && process.platform === 'win32'
      ? [quoteCommandArgument(file), ...args].join(' ')
      : args;
    handle = pty.spawn(file, command, {
      name: 'dumb',
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      cwd: params.cwd,
      env: stringEnvironment(params.env)
    });
  } catch (error) {
    throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
  }
  const transport = createPtyTransport(handle);
  handle.onData(data => callbacks.output(Buffer.from(data, 'utf8')));
  handle.onExit(event => {
    callbacks.exited(event.exitCode);
    callbacks.outputClosed();
  });
  return transport;
}

function launchPipe(
  params: SpawnParams,
  callbacks: ProcessCallbacks,
  file: string,
  args: string[]
): ProcessTransport {
  let child: ChildProcess;
  try {
    const verbatim = params.shellType === 'cmd' && process.platform === 'win32';
    child = spawn(file, args, {
      cwd: params.cwd,
      env: params.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(verbatim ? { windowsVerbatimArguments: true } : {})
    });
  } catch (error) {
    throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
  }

  let openStreams = 0;
  let closed = false;
  const closeOutput = () => {
    if (closed) return;
    closed = true;
    callbacks.outputClosed();
  };
  const streams = [child.stdout, child.stderr];
  for (const stream of streams) {
    if (!stream) continue;
    openStreams++;
    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      openStreams--;
      if (openStreams === 0) closeOutput();
    };
    stream.on('data', (chunk: Buffer) => callbacks.output(chunk));
    stream.once('end', closeStream);
    stream.once('close', closeStream);
    stream.once('error', closeStream);
  }
  if (openStreams === 0) closeOutput();
  child.once('error', error => {
    callbacks.failed(error.message);
    callbacks.exited(null);
    closeOutput();
  });
  child.once('exit', (code, signal) => callbacks.exited(code === null && signal ? null : code));
  return createPipeTransport(child);
}
