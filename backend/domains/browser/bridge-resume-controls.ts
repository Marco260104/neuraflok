import type { Command } from './command-broker/model.js';
import type { ResumeJobView, ResumeStage } from './bridge-resume-types.js';
import type { ContinuationView } from '../sessions/continuity/continuation.js';

type Runtime = {
  abortContinuation(token: string, reason: string): boolean;
  abortContinuationNow(token: string, reason: string): Promise<boolean>;
  changed(): void;
  clearAutomaticCompactionState(entry: ContinuationView): void;
  clearCompactionState(entry: ContinuationView): void;
  continuationByToken(token: string): ContinuationView | null;
  continuationForSession(sessionId: string): ContinuationView | null;
  getCommands(): Command[];
  hasBrowserOpener(): boolean;
  isLeased(command: Command): boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
  pendingContinuations(): ContinuationView[];
  persistCommands(): void;
  removeCommandFromDurableSnapshot(commandId: string): Promise<void>;
  replaceCommands(commands: Command[]): void;
};

export function createBridgeResumeControls(runtime: Runtime) {
  const sessionTokens = new Map<string, string>();
  const runningStages = new Set<ResumeStage>(['handoff-pending', 'opening', 'waiting-for-browser']);

  function rememberToken(sessionId: string, token: string): void {
    sessionTokens.set(sessionId, token);
    if (sessionTokens.size > 50) {
      const oldest = sessionTokens.keys().next();
      if (!oldest.done) sessionTokens.delete(oldest.value);
    }
  }

  function resumeJobFor(sessionId: string): ResumeJobView | null {
    const token = sessionTokens.get(sessionId);
    const entry = token ? runtime.continuationByToken(token) : runtime.continuationForSession(sessionId);
    if (!entry) return null;
    const command = runtime.getCommands().find((item) => item.spec.type === 'resume' && item.spec.sessionId === sessionId);
    const stage: ResumeStage =
      entry.state === 'committed'
        ? 'done'
        : entry.state === 'aborted'
          ? 'failed'
          : entry.state === 'awaiting-summary'
            ? 'handoff-pending'
            : command && !runtime.isLeased(command) && !runtime.hasBrowserOpener()
              ? 'waiting-for-browser'
              : 'opening';
    return {
      sessionId,
      token: entry.token,
      stage,
      startedAt: entry.openedAt,
      automatic: entry.automatic,
      busy: runningStages.has(stage),
      handoffId: entry.handoffId,
      sourceSend: entry.sourceSend,
      destinationSend: entry.destinationSend,
      error: entry.error
    };
  }

  function cancelResume(sessionId: string): boolean {
    const token = sessionTokens.get(sessionId);
    const entry = token ? runtime.continuationByToken(token) : runtime.continuationForSession(sessionId);
    const aborted = entry ? runtime.abortContinuation(entry.token, 'cancelled') : false;
    const queued = runtime.getCommands().find((command) => command.spec.type === 'resume' && command.spec.sessionId === sessionId);
    const afterAbort = entry ? runtime.continuationByToken(entry.token) : null;
    if (!aborted && (afterAbort?.state === 'committing' || afterAbort?.state === 'committed')) return false;
    if (queued) {
      runtime.replaceCommands(runtime.getCommands().filter((command) => command !== queued));
      if (queued.timer) clearTimeout(queued.timer);
      queued.timer = null;
      runtime.persistCommands();
      runtime.logInfo(`bridge: cancelled the queued fresh chat for ${sessionId}`);
    }
    if (!aborted && !queued) return false;
    runtime.changed();
    return true;
  }

  async function cancelResumeNow(sessionId: string): Promise<boolean> {
    const token = sessionTokens.get(sessionId);
    const entry = token ? runtime.continuationByToken(token) : runtime.continuationForSession(sessionId);
    const queued = runtime.getCommands().find((command) => command.spec.type === 'resume' && command.spec.sessionId === sessionId) ?? null;
    if (entry?.state === 'committing' || entry?.state === 'committed') return false;
    let aborted = false;
    if (entry && entry.state !== 'aborted') {
      aborted = await runtime.abortContinuationNow(entry.token, 'cancelled');
      const afterAbort = runtime.continuationByToken(entry.token);
      if (!aborted && (afterAbort?.state === 'committing' || afterAbort?.state === 'committed')) return false;
    }
    if (!entry && !queued) return false;
    if (queued) {
      if (queued.timer) clearTimeout(queued.timer);
      queued.timer = null;
      try {
        await runtime.removeCommandFromDurableSnapshot(queued.id);
      } catch (error) {
        runtime.logWarn(`bridge: resume ${sessionId} was aborted but its command retirement will retry — ${error instanceof Error ? error.message : String(error)}`);
      }
      runtime.replaceCommands(runtime.getCommands().filter((command) => command !== queued));
      runtime.logInfo(`bridge: cancelled the queued fresh chat for ${sessionId}`);
    }
    if (!aborted && entry?.state !== 'aborted' && !queued) return false;
    if (entry) runtime.clearCompactionState(entry);
    runtime.changed();
    return true;
  }

  async function cancelAutomaticResumesNow(sessionId?: string): Promise<number> {
    let cancelled = 0;
    for (const entry of runtime.pendingContinuations()) {
      if (!entry.automatic) continue;
      if (sessionId && entry.sessionId !== sessionId) continue;
      if (await cancelResumeNow(entry.sessionId)) cancelled += 1;
      runtime.clearAutomaticCompactionState(entry);
    }
    return cancelled;
  }

  return {
    cancelAutomaticResumesNow,
    cancelResume,
    cancelResumeNow,
    rememberToken,
    reset: () => sessionTokens.clear(),
    resumeJobFor
  };
}
