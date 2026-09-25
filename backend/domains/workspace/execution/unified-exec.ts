// Coordinates execution sessions and publishes bounded results to tools.
import { CommandBatchDisplay } from './command-batch.js';
import { collectOutputUntilDeadline, POST_EXIT_CLOSE_WAIT_CAP_MS, raceWithTimeout } from './unified-exec-output-wait.js';
import { createUnifiedExecDelivery } from './unified-exec-delivery.js';
import type { CompletedOutputPage, OutputPublication } from './unified-exec-delivery.js';
import { createUnifiedExecStdin } from './unified-exec-stdin.js';
import type { UnifiedExecProcessStatus } from './unified-exec-stdin.js';
import type { ExecCommandToolOutput } from './exec-command-output.js';
import { approxTokensFromByteCount, type TruncationPolicy } from './output-bounds.js';
import {
  clampYieldTime,
  generateChunkId,
  MAX_UNIFIED_EXEC_PROCESSES,
  MIN_EMPTY_YIELD_TIME_MS
} from './unified-exec-constants.js';
import { UnifiedExecError, UnifiedExecProcess } from './unified-exec-process.js';
import { prefixPowershellScriptWithUtf8, type ShellType } from './shell.js';

export { UnifiedExecError, applyUnifiedExecEnv, COMPLETED_EXEC_OUTPUT_BYTES } from './unified-exec-process.js';
export type { ProcessCompletion, SpawnParams, UnifiedExecErrorKind } from './unified-exec-process.js';
export {
  execCommandResponseText,
  execCommandStructuredOutput,
  projectExecCommandOutput,
  truncatedOutput
} from './exec-command-output.js';
export type { ExecCommandToolOutput } from './exec-command-output.js';
export type { CompletedOutputPage, OutputPublication } from './unified-exec-delivery.js';

export const MAX_COMPLETED_EXEC_RESULTS = 64;


export interface ExecCommandRequest {
  classifyExit?: (exitCode: number | null, rawOutput: string) => boolean;
  batchMarker?: string;
  command: string[];
  shellType: ShellType;
  hookCommand: string;
  processId: number;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  cwd: string;
  // The virtual path this ran in, kept only so `session status` can name it.
  displayCwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
}

export interface WriteStdinRequest {
  processId: number;
  input: string;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  maxWriteStdinYieldTimeMs?: number;
}

export interface BackgroundTerminalInfo {
  processId: number;
  incarnation: number;
  command: string;
  cwd: string;
  pid: number;
  tty: boolean;
  startedAt: number;
}

interface ProcessEntry {
  classifyExit?: ExecCommandRequest['classifyExit'];
  batchMarker?: string;
  process: UnifiedExecProcess;
  processId: number;
  incarnation: number;
  cwd: string;
  hookCommand: string;
  tty: boolean;
  startedAt: number;
  initialExecCommandActive: boolean;
  // Cursor into this process's own completed buffer; offers never consume bytes.
  delivery?: { offset: number; offer?: { end: number; publication: OutputPublication } };
}

export interface BackgroundExecState {
  running: number[];
  exitedUnread: Array<{ processId: number; exitCode: number | null }>;
}

export class UnifiedExecProcessManager {
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly completed = new Map<number, Pick<ExecCommandToolOutput, 'rawOutput' | 'displayOutput' | 'exitCode' | 'benignExit'> & { identity: object }>();
  private releaseListener?: (processId: number) => void;
  private processChangeListener?: () => void;
  private readonly reservedProcessIds = new Set<number>();
  private nextProcessIncarnation = 1;
  private readonly maxWriteStdinYieldTimeMs: number;
  private readonly outputDelivery: ReturnType<typeof createUnifiedExecDelivery>;
  private readonly stdinOutput: ReturnType<typeof createUnifiedExecStdin>;

  constructor(maxWriteStdinYieldTimeMs: number) {
    this.maxWriteStdinYieldTimeMs = Math.max(maxWriteStdinYieldTimeMs, MIN_EMPTY_YIELD_TIME_MS);
    this.outputDelivery = createUnifiedExecDelivery({
      getEntry: processId => this.processes.get(processId),
      backgroundState: processIds => this.backgroundState(processIds),
      retainCompleted: processId => {
        const entry = this.processes.get(processId);
        if (entry) this.retainCompleted(entry);
      }
    });
    this.stdinOutput = createUnifiedExecStdin({
      getEntry: processId => this.processes.get(processId),
      getCompleted: processId => this.completed.get(processId),
      refreshProcessState: processId => this.refreshProcessState(processId),
      releaseProcessId: processId => this.releaseProcessId(processId),
      maxWriteStdinYieldTimeMs: this.maxWriteStdinYieldTimeMs
    });
  }

  // The custody registry drops ownership only when this manager really discards an id.
  setProcessReleaseListener(listener: (processId: number) => void): void {
    this.releaseListener = listener;
  }

  // Presentation observers may reread the manager after a process starts, exits or is discarded.
  setProcessChangeListener(listener: () => void): void {
    this.processChangeListener = listener;
  }

  private notifyProcessChange(): void {
    this.processChangeListener?.();
  }

  // Generate a bounded process id and retry collisions against active reservations.
  allocateProcessId(): number {
    for (;;) {
      const processId = 1_000 + Math.floor(Math.random() * (100_000 - 1_000));
      if (this.reservedProcessIds.has(processId) || this.completed.has(processId)) continue;
      this.reservedProcessIds.add(processId);
      return processId;
    }
  }

  releaseProcessId(processId: number): void {
    this.reservedProcessIds.delete(processId);
    this.processes.delete(processId);
    this.completed.delete(processId);
    this.releaseListener?.(processId);
    this.notifyProcessChange();
  }

  private retainCompleted(entry: ProcessEntry): void {
    const rawOutput = Buffer.from(entry.process.retainedOutput());
    const exitCode = entry.process.exitCode();
    this.processes.delete(entry.processId);
    this.reservedProcessIds.delete(entry.processId);
    this.completed.set(entry.processId, {
      identity: entry.process.identity,
      rawOutput, exitCode,
      ...(entry.batchMarker ? { displayOutput: new CommandBatchDisplay(entry.batchMarker).push(rawOutput, true) } : {}),
      benignExit: entry.process.benignExit(entry.classifyExit)
    });
    this.notifyProcessChange();
    while (this.completed.size > MAX_COMPLETED_EXEC_RESULTS) this.releaseProcessId(this.completed.keys().next().value!);
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    let process: UnifiedExecProcess;
    try {
      this.ensureProcessCapacity(request.processId);
    } catch (error) {
      this.releaseProcessId(request.processId);
      throw error;
    }
    try {
      // Prefix PowerShell scripts before launch so pipe output matches the terminal encoding.
      const command =
        request.shellType === 'powershell' ? prefixPowershellScriptWithUtf8(request.command) : request.command;
      process = await UnifiedExecProcess.spawn({
        batchMarker: request.batchMarker,
        command,
        shellType: request.shellType,
        cwd: request.cwd,
        env: request.env,
        tty: request.tty
      });
    } catch (error) {
      this.releaseProcessId(request.processId);
      throw error instanceof UnifiedExecError
        ? error
        : UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const start = Date.now();
    const incarnation = this.nextProcessIncarnation++;
    const wallStart = performance.now();
    // Stored before the yield wait, so interrupting the call cannot drop the session.
    const processStartedAlive = !process.hasExited() && process.exitCode() === null;
    if (processStartedAlive) {
      this.processes.set(request.processId, {
        process,
        processId: request.processId,
        incarnation,
        cwd: request.displayCwd,
        hookCommand: request.hookCommand,
        tty: request.tty,
        startedAt: start,
        initialExecCommandActive: true,
        classifyExit: request.classifyExit, batchMarker: request.batchMarker
      });
      void process.completion.then(
        () => this.notifyProcessChange(),
        () => this.notifyProcessChange()
      );
    }

    const deadline = start + clampYieldTime(request.yieldTimeMs);
    const collected = await collectOutputUntilDeadline(process, deadline);
    const wallTimeMs = Math.max(0, performance.now() - wallStart);

    const visible = collected.display ?? collected.raw;
    const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
    const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
    const rawOutput = collected.raw.toBytesWithOmissionMarker();
    const chunkId = generateChunkId();

    const failure = process.failureMessage();
    if (failure !== null) {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.processFailed(failure);
    }

    let responseProcessId: number | null;
    let exitCode: number | null;
    if (processStartedAlive) {
      const status = this.refreshProcessState(request.processId);
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }
    } else {
      this.retainCompleted({ process, processId: request.processId, cwd: request.displayCwd,
        hookCommand: request.hookCommand, tty: request.tty, startedAt: start, incarnation, initialExecCommandActive: false,
        classifyExit: request.classifyExit, batchMarker: request.batchMarker });
      responseProcessId = null;
      exitCode = process.exitCode();
    }

    const response = {
      ...(responseProcessId === null ? { completedSessionId: request.processId } : {
        completion: process.completion.then(async completion => {
          const closeVersion = process.outputClosedNotify.currentVersion();
          if (!process.outputClosed) {
            const closed = process.outputClosedNotify.notified(closeVersion);
            try { await raceWithTimeout([closed], POST_EXIT_CLOSE_WAIT_CAP_MS); } finally { closed.dispose(); }
          }
          return { ...completion, benignExit: process.benignExit(request.classifyExit) };
        })
      }),
      benignExit: process.benignExit(request.classifyExit),
      chunkId,
      wallTimeMs,
      rawOutput,
      ...(collected.display ? { displayOutput: collected.display.toBytesWithOmissionMarker() } : {}),
      truncationPolicy: request.truncationPolicy,
      maxOutputTokens: request.maxOutputTokens,
      processId: responseProcessId,
      exitCode,
      originalTokenCount,
      outputOmittedBytes
    };
    if (responseProcessId !== null) {
      const entry = this.processes.get(request.processId);
      if (entry?.process === process) entry.initialExecCommandActive = false;
    }
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    return this.stdinOutput.writeStdin(request);
  }

  // Live sessions, oldest id first.
  listProcesses(): BackgroundTerminalInfo[] {
    return [...this.processes.values()]
      .filter((entry) => !entry.process.hasExited())
      .sort((left, right) => left.processId - right.processId)
      .map((entry) => ({
        processId: entry.processId,
        incarnation: entry.incarnation,
        command: entry.hookCommand,
        cwd: entry.cwd,
        pid: entry.process.pid,
        tty: entry.tty,
        startedAt: entry.startedAt
      }));
  }

  // Non-destructive obligation view for a caller-owned set of retained sessions.
  backgroundState(processIds: ReadonlySet<number>): BackgroundExecState {
    const running: number[] = [];
    const exitedUnread: Array<{ processId: number; exitCode: number | null }> = [];
    for (const entry of this.processes.values()) {
      if (entry.initialExecCommandActive) continue;
      if (!processIds.has(entry.processId)) continue;
      if (entry.process.hasExited()) {
        exitedUnread.push({ processId: entry.processId, exitCode: entry.process.exitCode() });
      } else {
        running.push(entry.processId);
      }
    }
    return {
      running: running.sort((left, right) => left - right),
      exitedUnread: exitedUnread.sort((left, right) => left.processId - right.processId)
    };
  }

  // Exited rows not handled by the starting exec; polling releases these rows.
  exitedUnread(processIds: ReadonlySet<number>): Array<{ processId: number; exitCode: number | null }> {
    return this.backgroundState(processIds).exitedUnread;
  }

  // A later owner call acknowledges a successfully published page, even within one request ID.
  async acknowledgeCompletedOutput(processIds: ReadonlySet<number>, startedAt: number, except?: number): Promise<number[]> {
    return this.outputDelivery.acknowledgeCompletedOutput(processIds, startedAt, except);
  }

  // Offer one bounded page without draining the process. A broken response reoffers the same bytes; an older concurrent response cannot advance a newer delivery cursor.
  async offerCompletedOutput(
    processIds: ReadonlySet<number>, publication: OutputPublication, maxBytes: number
  ): Promise<CompletedOutputPage | null> {
    return this.outputDelivery.offerCompletedOutput(processIds, publication, maxBytes);
  }

  async terminateProcess(processId: number, expectedIncarnation?: number): Promise<boolean> {
    const entry = this.processes.get(processId);
    if (!entry) return false;
    // Reject stale terminal controls by checking the displayed process incarnation.
    if (expectedIncarnation !== undefined &&
        (entry.incarnation !== expectedIncarnation || entry.process.hasExited())) return false;
    if (!entry.process.hasExited()) await entry.process.terminate();
    const current = this.processes.get(processId);
    if (current && current.process === entry.process) {
      // Keep the entry until the original exec call refreshes its terminal state.
      if (current.initialExecCommandActive) return true;
      this.releaseProcessId(processId);
    }
    return true;
  }

  async terminateAllProcesses(): Promise<void> {
    const entries = [...this.processes.values()];
    for (const id of new Set([...this.reservedProcessIds, ...this.completed.keys()])) this.releaseListener?.(id);
    this.completed.clear();
    this.processes.clear();
    this.reservedProcessIds.clear();
    // App shutdown is the caller that matters, so this has to behave like `terminateProcess` does for one id: skip the sessions that are already gone rather than spending a taskkill on each. Awaiting them one after another also made a quit cost the *sum* of every termination, and let a single rejection abandon every session queued behind it.
    await Promise.allSettled(
      entries.filter((entry) => !entry.process.hasExited()).map((entry) => entry.process.terminate())
    );
  }

  private refreshProcessState(processId: number): UnifiedExecProcessStatus {
    const entry = this.processes.get(processId);
    if (!entry) return { kind: 'unknown' };
    const exitCode = entry.process.exitCode();
    if (entry.process.hasExited()) {
      this.retainCompleted(entry);
      return { kind: 'exited', exitCode };
    }
    return { kind: 'alive', exitCode, processId: entry.processId };
  }

  // Capacity is admission, never garbage collection: every retained row still owes output.
  private ensureProcessCapacity(requestProcessId: number): void {
    // Reservations participate in the hard cap, so concurrent exec_command calls cannot each observe one free slot and collectively insert a 65th live process.
    if (this.reservedProcessIds.size > MAX_UNIFIED_EXEC_PROCESSES) {
      throw UnifiedExecError.createProcess(
        `too many retained terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES}); drain a returned session with write_stdin before starting another`
      );
    }
    if (!this.reservedProcessIds.has(requestProcessId)) {
      throw UnifiedExecError.createProcess('terminal session reservation was lost before launch');
    }
  }
}


