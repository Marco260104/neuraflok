export interface ShutdownPhase {
  readonly name: string;
  readonly budgetMs: number;
  readonly run: () => Array<Promise<unknown>>;
}

export interface ShutdownHooks {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly exit: () => void;
}

type PhaseOutcome =
  | { kind: 'settled'; results: PromiseSettledResult<unknown>[] }
  | { kind: 'expired' };

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function waitForPhase(
  completion: Promise<PromiseSettledResult<unknown>[]>,
  budgetMs: number
): Promise<PhaseOutcome> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<PhaseOutcome>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'expired' }), Math.max(0, budgetMs));
    timer.unref?.();
  });
  return Promise.race([
    completion.then(results => ({ kind: 'settled', results } as const)),
    deadline
  ]).finally(() => clearTimeout(timer));
}

function reportFailures(name: string, results: PromiseSettledResult<unknown>[], hooks: ShutdownHooks): void {
  for (const result of results) {
    if (result.status === 'rejected') hooks.error(`shutdown ${name} failed: ${describe(result.reason)}`);
  }
}

export async function runShutdownSequence(
  phases: readonly ShutdownPhase[],
  hooks: ShutdownHooks
): Promise<void> {
  try {
    for (const phase of phases) {
      hooks.info(`shutdown ${phase.name} starting`);
      let tasks: Array<Promise<unknown>>;
      try {
        tasks = phase.run();
      } catch (error) {
        hooks.error(`shutdown ${phase.name} failed: ${describe(error)}`);
        continue;
      }

      const completion = Promise.allSettled(tasks);
      const outcome = await waitForPhase(completion, phase.budgetMs);
      if (outcome.kind === 'expired') {
        hooks.warn(`shutdown ${phase.name} did not finish within ${phase.budgetMs}ms; continuing to quit`);
        continue;
      }
      reportFailures(phase.name, outcome.results, hooks);
      hooks.info(`shutdown ${phase.name} done`);
    }
    hooks.info('shutdown sequence complete');
  } finally {
    hooks.exit();
  }
}
