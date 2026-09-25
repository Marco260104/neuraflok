import { BoundedOutputBuffer } from './output/bounded-buffer.js';
import { CommandBatchDisplay } from './command-batch.js';
import { AsyncMutex, ProcessSignal } from './process-synchronization.js';
import { UnifiedExecError } from './process-errors.js';
import { launchProcess, type ProcessTransport, type SpawnParams } from './process-launch.js';

type ExitClassifier = (exitCode: number | null, rawOutput: string) => boolean;

export interface ProcessCompletion {
  benignExit?: boolean;
  exitCode: number | null;
  completedAt: number;
  durationMs: number;
}

const EARLY_EXIT_GRACE_PERIOD_MS = 150;
export const COMPLETED_EXEC_OUTPUT_BYTES = 256 * 1024;

export class UnifiedExecProcess {
  readonly identity = {};
  readonly tty: boolean;
  private readonly startedAt = Date.now();
  private resolveCompletion!: (value: ProcessCompletion) => void;
  readonly completion = new Promise<ProcessCompletion>(resolve => { this.resolveCompletion = resolve; });
  private buffer = new BoundedOutputBuffer();
  private readonly history = new BoundedOutputBuffer(COMPLETED_EXEC_OUTPUT_BYTES);
  private displayBuffer: BoundedOutputBuffer | undefined;
  private readonly batchDisplay: CommandBatchDisplay | undefined;
  private transport: ProcessTransport | null = null;
  readonly outputNotify = new ProcessSignal();
  readonly outputClosedNotify = new ProcessSignal();
  readonly cancelNotify = new ProcessSignal();
  readonly interactionLock = new AsyncMutex();
  outputClosed = false;
  cancelled = false;
  private exited = false;
  private exit: number | null = null;
  private failure: string | null = null;

  private constructor(tty: boolean, batchMarker?: string) {
    this.tty = tty;
    if (batchMarker) {
      this.batchDisplay = new CommandBatchDisplay(batchMarker);
      this.displayBuffer = new BoundedOutputBuffer();
    }
  }

  get pid(): number {
    return this.transport?.pid ?? -1;
  }

  static async spawn(params: SpawnParams): Promise<UnifiedExecProcess> {
    const managed = new UnifiedExecProcess(params.tty, params.batchMarker);
    try {
      const transport = await launchProcess(params, {
        output: chunk => managed.pushChunk(chunk),
        exited: exitCode => managed.signalExit(exitCode),
        outputClosed: () => managed.closeOutput(),
        failed: message => {
          managed.failure = message;
          managed.signalExit(null);
          managed.closeOutput();
        }
      });
      managed.transport = transport;
      await managed.waitForEarlyExit();
      if (managed.failure !== null && !transport.started) throw UnifiedExecError.createProcess(managed.failure);
      return managed;
    } catch (error) {
      if (error instanceof UnifiedExecError) throw error;
      throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }
  }

  private async waitForEarlyExit(): Promise<void> {
    if (this.cancelled) return;
    const wait = this.cancelNotify.notified();
    try {
      await Promise.race([wait.promise, sleep(EARLY_EXIT_GRACE_PERIOD_MS)]);
    } finally {
      wait.dispose();
    }
  }

  private pushChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.history.pushChunk(chunk);
    this.buffer.pushChunk(chunk);
    if (this.batchDisplay) this.displayBuffer!.pushChunk(this.batchDisplay.push(chunk));
    this.outputNotify.notifyAll();
  }

  private closeOutput(): void {
    if (this.outputClosed) return;
    if (this.batchDisplay) this.displayBuffer!.pushChunk(this.batchDisplay.push(Buffer.alloc(0), true));
    this.outputClosed = true;
    this.outputClosedNotify.notifyAll();
  }

  private signalExit(exitCode: number | null): void {
    if (!this.exited) {
      this.exited = true;
      this.exit = exitCode;
      const completedAt = Date.now();
      this.resolveCompletion({ exitCode, completedAt, durationMs: Math.max(0, completedAt - this.startedAt) });
    }
    if (!this.cancelled) {
      this.cancelled = true;
      this.cancelNotify.notifyAll();
    }
  }

  takeBuffer(): { raw: BoundedOutputBuffer; display?: BoundedOutputBuffer } {
    const drained = { raw: this.buffer, display: this.displayBuffer };
    this.buffer = new BoundedOutputBuffer();
    if (this.displayBuffer) this.displayBuffer = new BoundedOutputBuffer();
    return drained;
  }

  completedOutput(): Buffer | null {
    return this.hasExited() && this.outputClosed
      ? (this.displayBuffer ?? this.buffer).toBytesWithOmissionMarker()
      : null;
  }

  retainedOutput(): Buffer {
    return this.history.toBytesWithOmissionMarker();
  }

  benignExit(classify: ExitClassifier | undefined): boolean {
    return this.hasExited() && this.outputClosed && this.history.omittedBytes() === 0 &&
      (classify?.(this.exitCode(), this.retainedOutput().toString('utf8')) ?? false);
  }

  hasExited(): boolean {
    return this.exited;
  }

  exitCode(): number | null {
    return this.exit;
  }

  failureMessage(): string | null {
    return this.failure;
  }

  async write(data: string): Promise<void> {
    if (!this.tty || !this.transport) throw UnifiedExecError.writeToStdin();
    try {
      this.transport.write(data);
    } catch {
      throw UnifiedExecError.writeToStdin();
    }
  }

  async interrupt(): Promise<void> {
    if (!this.transport) throw UnifiedExecError.processFailed('the process is no longer running');
    try {
      await this.transport.interrupt();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async terminate(): Promise<void> {
    await this.transport?.terminate();
    this.signalExit(this.exit);
    this.closeOutput();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}
