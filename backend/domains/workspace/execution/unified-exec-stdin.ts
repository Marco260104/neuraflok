import type { ExecCommandToolOutput } from './exec-command-output.js';
import { approxTokenCount, approxTokensFromByteCount } from './output-bounds.js';
import { collectOutputUntilDeadline } from './unified-exec-output-wait.js';
import {
  generateChunkId,
  INTERRUPT,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS
} from './unified-exec-constants.js';
import { sleep, UnifiedExecError, UnifiedExecProcess } from './unified-exec-process.js';
import type { WriteStdinRequest } from './unified-exec.js';

interface StdinProcessEntry {
  classifyExit?: (exitCode: number | null, rawOutput: string) => boolean;
  process: UnifiedExecProcess;
  processId: number;
  tty: boolean;
  delivery?: { offset: number; offer?: { end: number } };
}

interface SavedCompletedProcess {
  identity: object;
  rawOutput: Buffer;
  displayOutput?: Buffer;
  exitCode: number | null;
  benignExit?: boolean;
}

export type UnifiedExecProcessStatus =
  | { kind: 'alive'; exitCode: number | null; processId: number }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'unknown' };

interface Runtime {
  getEntry(processId: number): StdinProcessEntry | undefined;
  getCompleted(processId: number): SavedCompletedProcess | undefined;
  refreshProcessState(processId: number): UnifiedExecProcessStatus;
  releaseProcessId(processId: number): void;
  maxWriteStdinYieldTimeMs: number;
}

export function createUnifiedExecStdin(runtime: Runtime) {
  async function writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const replay = (identity?: object): ExecCommandToolOutput | null => {
      const saved = runtime.getCompleted(request.processId);
      if (!saved) return null;
      if (identity && saved.identity !== identity) throw UnifiedExecError.unknownProcessId(request.processId);
      if (request.input !== '') throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
      return { ...saved, chunkId: generateChunkId(), wallTimeMs: 0, processId: null,
        completedSessionId: request.processId, replayed: true, originalTokenCount: approxTokenCount((saved.displayOutput ?? saved.rawOutput).toString('utf8')),
        outputOmittedBytes: null, truncationPolicy: request.truncationPolicy, maxOutputTokens: request.maxOutputTokens };
    };
    const saved = replay();
    if (saved) return saved;
    const entry = runtime.getEntry(request.processId);
    if (!entry) throw UnifiedExecError.unknownProcessId(request.processId);
    const locked = entry.process;

    // Reads and writes against one session must not overlap because they share a draining buffer.
    const release = await locked.interactionLock.lock();
    try {
      const saved = replay(locked.identity);
      if (saved) return saved;
      const current = runtime.getEntry(request.processId);
      if (!current || current.process !== locked) throw UnifiedExecError.unknownProcessId(request.processId);
      const { process, tty } = { process: current.process, tty: current.tty };

      let statusAfterWrite: UnifiedExecProcessStatus | null = null;
      if (request.input !== '') {
        if (process.hasExited()) throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
        if (!tty) {
          if (request.input === INTERRUPT) {
            await process.interrupt();
          } else {
            throw UnifiedExecError.stdinClosed();
          }
        } else {
          try {
            await process.write(request.input);
            // A brief window lets the child's reaction land in the next poll.
            await sleep(100);
          } catch (error) {
            const status = runtime.refreshProcessState(request.processId);
            if (status.kind === 'exited') {
              statusAfterWrite = status;
            } else if (error instanceof UnifiedExecError && error.kind === 'process_failed') {
              await process.terminate();
              runtime.releaseProcessId(request.processId);
              throw error;
            } else {
              throw error;
            }
          }
        }
      }

      const maxEmptyYield = Math.max(
        request.maxWriteStdinYieldTimeMs ?? runtime.maxWriteStdinYieldTimeMs,
        MIN_EMPTY_YIELD_TIME_MS
      );
      const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
      const yieldTimeMs = request.input === ''
        ? Math.min(Math.max(base, MIN_EMPTY_YIELD_TIME_MS), maxEmptyYield)
        : Math.min(base, MAX_YIELD_TIME_MS);

      const start = Date.now();
      const wallStart = performance.now();
      // Empty calls return available output immediately; writes collect through the bounded yield window.
      const collected = await collectOutputUntilDeadline(process, start + yieldTimeMs, request.input === '');
      const wallTimeMs = Math.max(0, performance.now() - wallStart);

      const visible = collected.display ?? collected.raw;
      const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
      const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
      // An explicit poll may replay an offered page but must not repeat pages already acknowledged automatically.
      const deliveredOffset = current.delivery?.offset ?? 0;
      const rawOutput = deliveredOffset > 0
        ? visible.toBytesWithOmissionMarker().subarray(deliveredOffset)
        : collected.raw.toBytesWithOmissionMarker();
      const chunkId = generateChunkId();

      const failure = process.failureMessage();
      if (failure !== null) {
        runtime.releaseProcessId(request.processId);
        throw UnifiedExecError.processFailed(failure);
      }

      const status = statusAfterWrite ?? runtime.refreshProcessState(request.processId);
      let responseProcessId: number | null;
      let exitCode: number | null;
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else if (process.hasExited()) {
        responseProcessId = null;
        exitCode = process.exitCode();
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }

      return {
        ...(responseProcessId === null ? { completedSessionId: request.processId } : {}),
        benignExit: process.benignExit(current.classifyExit),
        chunkId,
        wallTimeMs,
        rawOutput,
        ...(collected.display ? { displayOutput: deliveredOffset > 0 ? rawOutput : collected.display.toBytesWithOmissionMarker() } : {}),
        truncationPolicy: request.truncationPolicy,
        maxOutputTokens: request.maxOutputTokens,
        processId: responseProcessId,
        exitCode,
        originalTokenCount,
        outputOmittedBytes
      };
    } finally {
      release();
    }
  }

  return { writeStdin };
}
