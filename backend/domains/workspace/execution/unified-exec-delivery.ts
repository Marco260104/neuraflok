export interface OutputPublication {
  completedAt: number | null;
  failed: boolean;
}

export interface CompletedOutputPage {
  processId: number;
  command: string;
  exitCode: number | null;
  output: string;
  start: number;
  end: number;
  total: number;
}

interface DeliveryEntry {
  processId: number;
  hookCommand: string;
  initialExecCommandActive: boolean;
  process: {
    interactionLock: { lock(): Promise<() => void> };
    completedOutput(): Buffer | null;
    exitCode(): number | null;
  };
  delivery?: { offset: number; offer?: { end: number; publication: OutputPublication } };
}

interface Runtime {
  getEntry(processId: number): DeliveryEntry | undefined;
  backgroundState(processIds: ReadonlySet<number>): { exitedUnread: Array<{ processId: number; exitCode: number | null }> };
  retainCompleted(processId: number): void;
}

export function createUnifiedExecDelivery(runtime: Runtime) {
  async function acknowledgeCompletedOutput(processIds: ReadonlySet<number>, startedAt: number, except?: number): Promise<number[]> {
    const retired: number[] = [];
    for (const id of processIds) {
      if (id === except) continue;
      const entry = runtime.getEntry(id);
      if (!entry?.delivery?.offer) continue;
      const release = await entry.process.interactionLock.lock();
      try {
        if (runtime.getEntry(id) !== entry) continue;
        const offered = entry.delivery?.offer;
        if (!offered || offered.publication.failed || offered.publication.completedAt === null ||
            startedAt <= offered.publication.completedAt) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        entry.delivery = { offset: offered.end };
        if (offered.end >= output.length) {
          runtime.retainCompleted(id);
          retired.push(id);
        }
      } finally {
        release();
      }
    }
    return retired;
  }

  async function offerCompletedOutput(
    processIds: ReadonlySet<number>, publication: OutputPublication, maxBytes: number
  ): Promise<CompletedOutputPage | null> {
    if (publication.failed || maxBytes < 4) return null;
    for (const { processId } of runtime.backgroundState(processIds).exitedUnread) {
      const entry = runtime.getEntry(processId);
      if (!entry) continue;
      const release = await entry.process.interactionLock.lock();
      try {
        if (runtime.getEntry(processId) !== entry || entry.initialExecCommandActive) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        const delivery = entry.delivery ??= { offset: 0 };
        if (delivery.offer && !delivery.offer.publication.failed) continue;
        const start = delivery.offset;
        let end = Math.min(output.length, start + Math.floor(maxBytes));
        while (end > start && end < output.length && (output[end]! & 0xc0) === 0x80) end--;
        if (end === start && output.length > start) continue;
        delivery.offer = { end, publication };
        return {
          processId,
          command: entry.hookCommand,
          exitCode: entry.process.exitCode(),
          output: output.subarray(start, end).toString('utf8'),
          start,
          end,
          total: output.length
        };
      } finally {
        release();
      }
    }
    return null;
  }

  return { acknowledgeCompletedOutput, offerCompletedOutput };
}
