import type { SessionEvent } from '../../../../contracts/session.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { requestCorrelation } from './correlation.js';
import {
  appendEvent,
  getSession,
  indexedSessions,
  readAsset,
  readEvents,
  rewriteUnattributedToolCalls,
  writeAsset
} from './store.js';

interface AttributionRepairRuntime {
  recordingEnabled(): boolean;
  activeSessionId(): string | null;
  setActiveSessionId(sessionId: string | null): void;
  unattributedSessionId(): string | null;
  setUnattributedSessionId(sessionId: string | null): void;
  notifyChanged(...sessionIds: string[]): void;
}

export function createAttributionRepair(runtime: AttributionRepairRuntime) {
  const repairBuckets = new Map<string, { toolCalls: number; updatedAt: number; requestIds: Set<string> }>();
  const maxRepairBuckets = 128;
  const maxRepairRequestIds = MAX_REPAIR_REQUEST_IDS;

  async function repairDeterministicAttribution(affected?: ReadonlySet<string>): Promise<{ sessions: number; calls: number }> {
    if (!runtime.recordingEnabled()) return { sessions: 0, calls: 0 };
    let repairedSessions = 0;
    let repairedCalls = 0;
    const changed = new Set<string>();

    for (const summary of await indexedSessions()) {
      if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
      const cached = repairBuckets.get(summary.id);
      if (affected && cached?.toolCalls === summary.toolCalls && cached.updatedAt === summary.updatedAt &&
          ![...affected].some((id) => cached.requestIds.has(id))) continue;
      const events = await readEvents(summary.id);
      const scannedThroughSeq = events.reduce((highest, event) => Math.max(highest, event.seq), 0);
      const tools = events.filter(
        (event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call'
      );
      const requestIds = new Set<string>();
      for (const event of tools) {
        if (event.call.requestId) requestIds.add(event.call.requestId);
        if (requestIds.size > maxRepairRequestIds) break;
      }
      repairBuckets.delete(summary.id);
      if (requestIds.size <= maxRepairRequestIds) {
        let total = requestIds.size;
        for (const bucket of repairBuckets.values()) total += bucket.requestIds.size;
        while (repairBuckets.size >= maxRepairBuckets || total > maxRepairRequestIds) {
          const oldest = repairBuckets.keys().next().value!;
          total -= repairBuckets.get(oldest)!.requestIds.size;
          repairBuckets.delete(oldest);
        }
        repairBuckets.set(summary.id, { toolCalls: summary.toolCalls, updatedAt: summary.updatedAt, requestIds });
      }
      if (tools.length === 0) continue;
      if (events.some((event) => event.kind !== 'session_start' && event.kind !== 'tool_call')) continue;

      const owned = new Map<
        string,
        Array<{ event: Extract<SessionEvent, { kind: 'tool_call' }>; conversationId: string }>
      >();
      const unknown: Extract<SessionEvent, { kind: 'tool_call' }>[] = [];
      for (const event of tools) {
        // Superseded calls remain isolated even if their request correlation is replayed.
        if (event.call.attributionMethod === 'superseded' || event.call.attribution === 'superseded') {
          unknown.push(event);
          continue;
        }
        const requestId = event.call.requestId;
        const correlation = requestId ? requestCorrelation(requestId) : null;
        if (!correlation) {
          unknown.push(event);
          continue;
        }
        const group = owned.get(correlation.sessionId);
        const placed = { event, conversationId: correlation.conversationId };
        if (group) group.push(placed);
        else owned.set(correlation.sessionId, [placed]);
      }
      if (owned.size === 0) continue;

      // Copy all referenced assets before appending or removing any event.
      const destinations = new Map<string, string>();
      let assetsComplete = true;
      try {
        for (const [targetSessionId, group] of owned) {
          const target = await getSession(targetSessionId);
          if (!target || targetSessionId === summary.id) {
            assetsComplete = false;
            break;
          }
          destinations.set(targetSessionId, targetSessionId);

          const assets = new Map<string, string>();
          for (const { event } of group) {
            if (event.call.args.assetId) assets.set(event.call.args.assetId, 'text/plain');
            if (event.call.result.assetId) assets.set(event.call.result.assetId, 'text/plain');
            for (const change of event.call.changes ?? []) if (change.reviewAssetId) assets.set(change.reviewAssetId, 'text/plain');
            for (const asset of event.call.assets ?? []) assets.set(asset.id, asset.mimeType);
          }
          for (const [assetId, mimeType] of assets) {
            const data = await readAsset(summary.id, assetId);
            if (!data) {
              assetsComplete = false;
              break;
            }
            await writeAsset(targetSessionId, data, mimeType);
          }
          if (!assetsComplete) break;
        }
      } catch (err) {
        assetsComplete = false;
        logWarn(`could not repair unattributed session ${summary.id}: ${(err as Error).message}`);
      }
      if (!assetsComplete) continue;

      let firstTargetSessionId: string | null = null;
      for (const [sessionKey, group] of owned) {
        const targetSessionId = destinations.get(sessionKey)!;
        firstTargetSessionId ??= targetSessionId;
        const existingCallIds = new Set(
          (await readEvents(targetSessionId, { kinds: ['tool_call'] }))
            .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
            .map((event) => event.call.callId)
        );
        for (const { event, conversationId } of group) {
          if (existingCallIds.has(event.call.callId)) continue;
          await appendEvent(targetSessionId, {
            time: event.time,
            source: 'mcp',
            kind: 'tool_call',
            call: {
              ...event.call,
              attribution: 'request_id',
              conversationId,
              attributionMethod: 'request_id'
            },
            ...(event.agent ? { agent: event.agent } : {}),
            ...(event.turnId ? { turnId: event.turnId } : {})
          });
          existingCallIds.add(event.call.callId);
          repairedCalls += 1;
        }
      }

      let repaired: { retained: number; deleted: boolean };
      try {
        repaired = await rewriteUnattributedToolCalls(
          summary.id,
          unknown,
          scannedThroughSeq,
          summary.id !== runtime.unattributedSessionId()
        );
      } finally {
        // Invalidate the cache after rewriting because concurrent arrivals may share its counters.
        repairBuckets.delete(summary.id);
      }
      if (repaired.retained === 0 && runtime.activeSessionId() === summary.id) {
        runtime.setActiveSessionId(firstTargetSessionId);
      }
      if (!repaired.deleted && runtime.unattributedSessionId() === null) {
        runtime.setUnattributedSessionId(summary.id);
      }
      repairedSessions += 1;
      changed.add(summary.id);
      for (const id of destinations.values()) changed.add(id);
      logInfo(
        `repaired ${tools.length - unknown.length} deterministically attributed call(s) from session ${summary.id}; ` +
          `${repaired.retained} remain unknown`
      );
    }

    if (repairedSessions > 0) runtime.notifyChanged(...changed);
    return { sessions: repairedSessions, calls: repairedCalls };
  }

  return { repair: repairDeterministicAttribution, reset: () => repairBuckets.clear() };
}

export const MAX_REPAIR_REQUEST_IDS = 50_000;
