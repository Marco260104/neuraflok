import { awaitRequestCorrelation, observeRequestCorrelations, requestCorrelation, resetCorrelationRegistryForTests } from './correlation.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { MAX_REPAIR_REQUEST_IDS } from './attribution-repair.js';
import type { PageCallEvidence } from './recorder-observations.js';

type Runtime = {
  repair(affected?: ReadonlySet<string>): Promise<{ sessions: number; calls: number }>;
};

export function evidenceWindow(production: number): number {
  const raw = process.env.NEURAFLOK_EVIDENCE_MS;
  if (raw === undefined) return production;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, production) : production;
}

export const REQUEST_ID_GRACE_MS = evidenceWindow(20_000);

export function createRecorderRequestEvidence(runtime: Runtime) {
  let repairTimer: NodeJS.Timeout | null = null;
  let repairRequested = false;
  let fullRepairRequested = false;
  const repairRequestIds = new Set<string>();
  let repairChain: Promise<void> = Promise.resolve();

  function startRepair(): void {
    if (!repairRequested) return;
    repairRequested = false;
    const affected = fullRepairRequested ? undefined : new Set(repairRequestIds);
    fullRepairRequested = false;
    repairRequestIds.clear();
    const run = repairChain.then(async () => {
      try {
        await runtime.repair(affected);
      } catch (error) {
        logWarn(`late request attribution repair failed: ${(error as Error).message}`);
      }
      if (repairRequested) startRepair();
    });
    repairChain = run.then(() => undefined, () => undefined);
  }

  function queueDeterministicAttributionRepair(): void {
    repairRequested = true;
    fullRepairRequested = true;
    if (repairTimer) {
      clearTimeout(repairTimer);
      repairTimer = null;
    }
    startRepair();
  }

  function scheduleAttributionRepair(requestId: string): void {
    repairRequested = true;
    repairRequestIds.add(requestId);
    if (repairRequestIds.size > MAX_REPAIR_REQUEST_IDS) {
      repairRequestIds.clear();
      fullRepairRequested = true;
    }
    if (repairTimer) return;
    repairTimer = setTimeout(() => {
      repairTimer = null;
      startRepair();
    }, 250);
    repairTimer.unref?.();
  }

  function noteCallEvidence(
    conversationId: string,
    sessionId: string,
    fiberConversationId: string | null | undefined,
    calls: readonly PageCallEvidence[],
    at: number
  ): boolean {
    // Request IDs are the only cross-process ownership proof; a URL/Fiber disagreement proves neither side.
    if (fiberConversationId && fiberConversationId !== conversationId) {
      const dropped = calls.map(call => call.requestId).filter((id): id is string => !!id);
      logWarn(
        `request attribution: ignoring ${calls.length} sighting(s) — URL conversation ${conversationId} disagrees ` +
          `with Fiber conversation ${fiberConversationId}. Later agreeing evidence can still prove these calls.` +
          (dropped.length > 0 ? ` Discarded request ids: ${dropped.join(', ')}.` : '')
      );
      return false;
    }
    const observedAt = Math.min(at, Date.now());
    const evidencedCalls = calls.filter((call): call is PageCallEvidence & { requestId: string } => !!call.requestId);
    const priorOwners = new Map(
      evidencedCalls.map(call => [call.requestId, requestCorrelation(call.requestId)?.conversationId ?? null] as const)
    );
    const results = observeRequestCorrelations(evidencedCalls.map(call => ({
      requestId: call.requestId,
      conversationId,
      sessionId,
      messageId: call.messageId,
      tool: call.tool,
      observedAt
    })));
    const refusals = new Set<string>();
    let stored = false;
    for (const [index, call] of evidencedCalls.entries()) {
      const result = results[index]!;
      if (result === 'refused') {
        if (!refusals.has(call.requestId)) {
          refusals.add(call.requestId);
          logInfo(
            `request attribution: ${call.requestId} stays with conversation ${priorOwners.get(call.requestId)}` +
              `; conversation ${conversationId} claimed it too and was refused`
          );
        }
      } else if (result === 'stored') {
        stored = true;
        logInfo(`request attribution: ${call.requestId} -> conversation ${conversationId}`);
        scheduleAttributionRepair(call.requestId);
      }
    }
    return stored;
  }

  function freshCallOrigin(tool: string, after: number, requestId: string | null = null): string | null {
    void tool;
    void after;
    return requestCorrelation(requestId)?.conversationId ?? null;
  }

  async function awaitFreshCallOrigin(
    tool: string,
    after: number,
    within: number,
    options: { exact?: boolean; requestId?: string | null } = {}
  ): Promise<string | null> {
    void tool;
    void after;
    void options.exact;
    const correlation = await awaitRequestCorrelation(options.requestId ?? null, within);
    return correlation?.conversationId ?? null;
  }

  async function flush(): Promise<void> {
    if (repairTimer) {
      clearTimeout(repairTimer);
      repairTimer = null;
      startRepair();
    }
    await repairChain.catch(() => undefined);
  }

  function reset(): void {
    resetCorrelationRegistryForTests();
    if (repairTimer) {
      clearTimeout(repairTimer);
      repairTimer = null;
    }
    repairRequested = false;
    repairChain = Promise.resolve();
    fullRepairRequested = false;
    repairRequestIds.clear();
  }

  return {
    noteCallEvidence,
    freshCallOrigin,
    awaitFreshCallOrigin,
    queueDeterministicAttributionRepair,
    flush,
    reset
  };
}
