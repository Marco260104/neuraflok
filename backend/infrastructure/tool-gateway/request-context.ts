import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutputPublication } from '../../domains/workspace/execution/unified-exec.js';

export type ToolExecutionPhase = 'identity' | 'handler' | 'delivery' | 'recorder';

export interface ToolRequestTiming {
  startedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  calls: number;
  phases: Record<ToolExecutionPhase, number>;
}

export interface ToolRequestScope {
  requestId: string | null;
  timing?: ToolRequestTiming;
  publication?: OutputPublication;
}

const toolRequestScope = new AsyncLocalStorage<ToolRequestScope>();

function emptyPhaseDurations(): Record<ToolExecutionPhase, number> {
  return { identity: 0, handler: 0, delivery: 0, recorder: 0 };
}

export function createToolRequestTiming(): ToolRequestTiming {
  return {
    startedAt: performance.now(),
    dispatchedAt: null,
    completedAt: null,
    calls: 0,
    phases: emptyPhaseDurations()
  };
}

export function beginToolExecutionTiming(): (phase: ToolExecutionPhase, complete?: boolean) => void {
  const timing = toolRequestScope.getStore()?.timing;
  let previousMark = performance.now();
  if (timing) {
    timing.calls += 1;
    timing.dispatchedAt ??= previousMark;
  }

  return (phase, complete = false) => {
    const markedAt = performance.now();
    if (timing) {
      timing.phases[phase] += Math.max(0, markedAt - previousMark);
      if (complete) timing.completedAt = markedAt;
    }
    previousMark = markedAt;
  };
}

export function runInToolRequestScope<T>(scope: ToolRequestScope, operation: () => T): T {
  return toolRequestScope.run(scope, operation);
}

export function currentOutputPublication(): OutputPublication | undefined {
  return toolRequestScope.getStore()?.publication;
}

export function currentToolRequestId(): string | null {
  return toolRequestScope.getStore()?.requestId ?? null;
}
