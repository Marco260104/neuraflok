import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent, SessionSummary } from '../../../../contracts/session.js';
import { MAX_TOOL_RESULT_TOKENS, storedTextTokens } from '../../../../contracts/session.js';
import { applyTurnIdentity, positionOf, type Chronological } from '../../../../contracts/chronology.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { applyToSummary, emptySummary } from './session-summary-projection.js';

export interface SessionHistoryRebuilderDependencies {
  sessionDirectory(id: string): string;
  maxLineBytes: number;
  messageKey(event: SessionEvent): string | null;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
}

export function createSessionHistoryRebuilder(dependencies: SessionHistoryRebuilderDependencies) {
  const { sessionDirectory, maxLineBytes, messageKey, writeSummary } = dependencies;

  return async function rebuildSummaryFromHistory(
    id: string,
    messages: ReadonlyMap<string, SessionEvent>,
    checkpoint: SessionSummary | null,
    historySeq: number,
    preserveAttachmentTurn = false,
    migrateTokenEstimate = false
  ): Promise<SessionSummary> {
    const rebuilt = emptySummary(id, 'Recovered session', null);
    let sawProjected = false;
    let historicalReturnReduction = 0;
    const canonicalKeys = new Set(messages.keys());
    const identities: Chronological[] = [];
    const collectIdentity = (event: SessionEvent): void => {
      if (!['user_message', 'turn_start', 'turn_end', 'tool_call'].includes(event.kind)) return;
      identities.push({
        seq: event.seq,
        origin: positionOf(event),
        time: event.time,
        kind: event.kind,
        source: event.source,
        turnId: event.turnId,
        ...(event.kind === 'user_message' ? { messageId: event.messageId, inputId: event.inputId } : {}),
        ...(event.kind === 'tool_call' ? {
          call: {
            requestId: event.call.requestId,
            conversationId: event.call.conversationId,
            attribution: event.call.attribution
          }
        } : {})
      });
    };

    let carry = Buffer.alloc(0);
    const handle = await fs.open(path.join(sessionDirectory(id), 'events.jsonl'), 'r').catch(() => null);
    const accept = (line: Buffer): void => {
      if (line.length === 0 || line.length > maxLineBytes) return;
      try {
        const event = JSON.parse(line.toString('utf8')) as SessionEvent;
        if (!event || typeof event.seq !== 'number' || typeof event.kind !== 'string') return;
        const key = messageKey(event);
        if (key && canonicalKeys.has(key)) return;
        if (!sawProjected) {
          rebuilt.startedAt = event.time;
          rebuilt.updatedAt = event.time;
        }
        if (!sawProjected && event.kind === 'session_start') rebuilt.title = event.title || rebuilt.title;
        const eventConversation = 'conversationId' in event && typeof event.conversationId === 'string'
          ? event.conversationId
          : null;
        if (eventConversation) {
          rebuilt.conversationId = eventConversation;
          if (!rebuilt.chatIds.includes(eventConversation)) rebuilt.chatIds.push(eventConversation);
        }
        if (
          migrateTokenEstimate && event.kind === 'tool_call' && checkpoint?.conversationId &&
          event.call.conversationId && event.call.conversationId !== checkpoint.conversationId
        ) {
          historicalReturnReduction += Math.max(0, storedTextTokens(event.call.result) - MAX_TOOL_RESULT_TOKENS);
        }
        applyToSummary(rebuilt, event);
        collectIdentity(event);
        sawProjected = true;
      } catch {
        // A torn or corrupt line costs that line, not the complete session projection.
      }
    };

    try {
      if (handle) {
        const chunk = Buffer.alloc(64 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          const joined = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
          let start = 0;
          for (;;) {
            const newline = joined.indexOf(0x0a, start);
            if (newline < 0) break;
            accept(joined.subarray(start, newline));
            start = newline + 1;
          }
          carry = joined.subarray(start);
          if (carry.length > maxLineBytes) carry = Buffer.alloc(0);
        }
        accept(carry);
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }

    for (const message of [...messages.values()].sort((left, right) => left.seq - right.seq)) {
      if (!sawProjected) {
        rebuilt.startedAt = message.time;
        rebuilt.updatedAt = message.time;
      }
      applyToSummary(rebuilt, message);
      collectIdentity(message);
      sawProjected = true;
    }
    if (!sawProjected) throw new Error(`Session ${id} has no recoverable metadata or history`);

    rebuilt.timelineTurns = {};
    rebuilt.requestTurns = {};
    rebuilt.nativeQuestion = null;
    for (const event of identities.sort((left, right) => positionOf(left) - positionOf(right))) {
      applyTurnIdentity(rebuilt, event);
    }

    const summary = checkpoint
      ? {
          ...checkpoint,
          updatedAt: Math.max(checkpoint.updatedAt, rebuilt.updatedAt),
          events: rebuilt.events,
          timelineTurns: rebuilt.timelineTurns,
          requestTurns: rebuilt.requestTurns,
          nativeQuestion: rebuilt.nativeQuestion,
          userMessages: rebuilt.userMessages,
          toolCalls: rebuilt.toolCalls,
          lastToolCallAt: rebuilt.lastToolCallAt,
          lastToolActivity: rebuilt.lastToolActivity,
          lastAssistantFinalAt: rebuilt.lastAssistantFinalAt,
          lastTurnEndAt: rebuilt.lastTurnEndAt,
          lastFinishReportAt: rebuilt.lastFinishReportAt,
          processExitNonzero: rebuilt.processExitNonzero,
          toolRejected: rebuilt.toolRejected,
          toolInternalErrors: rebuilt.toolInternalErrors,
          errors: rebuilt.errors,
          estimatedTokens: rebuilt.estimatedTokens,
          contextTokens: Math.max(
            0,
            checkpoint.contextTokens + (rebuilt.estimatedTokens - checkpoint.estimatedTokens) + historicalReturnReduction
          ),
          lastHandoffId: rebuilt.lastHandoffId,
          lastHandoffAt: rebuilt.lastHandoffAt,
          lastTurnOutcome: rebuilt.lastTurnOutcome,
          activeTurnId: preserveAttachmentTurn ? checkpoint.activeTurnId ?? null : rebuilt.activeTurnId ?? null,
          finishTurn: rebuilt.finishTurn?.conversationId === checkpoint.conversationId ? rebuilt.finishTurn : null,
          agents: [...new Set([...checkpoint.agents, ...rebuilt.agents])]
        }
      : rebuilt;
    logWarn(`session ${id}: rebuilt metadata from durable event/message history`);
    await writeSummary(summary, historySeq);
    return summary;
  };
}
