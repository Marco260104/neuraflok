import { BoundedOutputBuffer } from './output/bounded-buffer.js';
import type { UnifiedExecProcess } from './unified-exec-process.js';

export const POST_EXIT_CLOSE_WAIT_CAP_MS = 50;

// Collects bounded output until the yield deadline or the post-exit stream-close grace expires.
export async function collectOutputUntilDeadline(
  process: UnifiedExecProcess,
  deadline: number,
  returnOnFirstOutput = false
): Promise<{ raw: BoundedOutputBuffer; display?: BoundedOutputBuffer }> {
  const collected = new BoundedOutputBuffer();
  let display: BoundedOutputBuffer | undefined;
  let exitSignalReceived = process.cancelled;
  let postExitDeadline: number | null = null;

  for (;;) {
    const outputVersion = process.outputNotify.currentVersion();
    const closeVersion = process.outputClosedNotify.currentVersion();
    const exitVersion = process.cancelNotify.currentVersion();
    const drained = process.takeBuffer();
    if (drained.display) {
      display ??= new BoundedOutputBuffer();
      display.pushBuffer(drained.display);
    }
    const hasDrainedOutput = drained.raw.retainedBytes() > 0 || drained.raw.omittedBytes() > 0;
    const waitForOutput = hasDrainedOutput ? null : process.outputNotify.notified(outputVersion);

    if (!hasDrainedOutput) {
      exitSignalReceived ||= process.cancelled;
      if (exitSignalReceived && process.outputClosed) {
        waitForOutput?.dispose();
        break;
      }
      const now = Date.now();
      const remaining = Math.max(0, deadline - now);
      if (remaining === 0) {
        waitForOutput?.dispose();
        break;
      }

      if (exitSignalReceived) {
        postExitDeadline ??= now + Math.min(remaining, POST_EXIT_CLOSE_WAIT_CAP_MS);
        const closeWaitRemaining = Math.max(0, postExitDeadline - now);
        if (closeWaitRemaining === 0) {
          waitForOutput?.dispose();
          break;
        }
        const closed = process.outputClosedNotify.notified(closeVersion);
        const timedOut = await raceWithTimeout([waitForOutput, closed], closeWaitRemaining);
        waitForOutput?.dispose();
        closed.dispose();
        if (timedOut) break;
        continue;
      }

      const exitNotified = process.cancelNotify.notified(exitVersion);
      const timedOut = await raceWithTimeout([waitForOutput, exitNotified], remaining);
      waitForOutput?.dispose();
      exitNotified.dispose();
      if (timedOut) break;
      exitSignalReceived ||= process.cancelled;
      continue;
    }

    collected.pushBuffer(drained.raw);
    if (returnOnFirstOutput) break;
    exitSignalReceived ||= process.cancelled;
    if (Date.now() >= deadline) break;
  }

  return { raw: collected, display };
}

// Resolves true when the timeout wins the race.
export async function raceWithTimeout(
  waits: ReadonlyArray<{ promise: Promise<void> } | null>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const races = waits.filter((wait): wait is { promise: Promise<void> } => wait !== null).map((wait) =>
      wait.promise.then(() => false)
    );
    return await Promise.race([...races, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
