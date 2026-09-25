import type { Handoff, SessionSummary } from '../../../contracts/session.js';
import type { ContinuationView } from '../sessions/continuity/continuation.js';
import { briefShortfall } from '../sessions/continuity/handoff.js';
import type { Command } from './command-broker/model.js';
import type { ResumeJobView } from './bridge-resume-types.js';
import type { BrowserPlacement } from './command-broker/delivery.js';

type CaptureResult = { status: number; body: Record<string, unknown> };

interface Runtime {
  abortContinuationNow(token: string, reason: string): Promise<boolean>;
  attachSummary(token: string, text: string): Promise<Handoff | null>;
  automaticCompactionAllowed(session: SessionSummary | null): boolean;
  cancelResumeNow(sessionId: string): Promise<boolean>;
  continuationByToken(token: string): ContinuationView | null;
  deliver(): Promise<void>;
  getSession(sessionId: string): Promise<SessionSummary | null>;
  logInfo(message: string): void;
  logWarn(message: string): void;
  noticeRefusal(key: string, message: string): void;
  pendingBrowserPlacement(conversationId: string): BrowserPlacement | null;
  queueResumeCommand(sessionId: string, token: string): Pick<Command, 'id'> | null;
  readHandoffResponse(
    sessionId: string,
    conversationId: string,
    anchor: string,
    token: string
  ): Promise<{ status: 'complete'; text: string; messageId: string } | { status: 'pending' | 'ambiguous' }>;
  resumeJobFor(sessionId: string): ResumeJobView | null;
  runningToolCalls(conversationId: string): number;
  setPlacementCollector(conversationId: string | null): void;
}

export function createBridgeHandoffCapture(runtime: Runtime) {
  async function abortRejectedResume(token: string, reason: string): Promise<boolean> {
    const state = runtime.continuationByToken(token);
    if (!state || state.state === 'committing' || state.state === 'committed' || state.state === 'aborted') return false;
    try {
      return await runtime.abortContinuationNow(token, reason);
    } catch (error) {
      runtime.logWarn(`bridge: could not durably abort the refused resume ${state.sessionId} — ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function captureCompactionBrief(
    conversationId: string,
    entry: ContinuationView,
    text: string,
    known: SessionSummary | null
  ): Promise<CaptureResult> {
    const { sessionId, token } = entry;
    const brief = text.trim();
    const source = known ?? await runtime.getSession(sessionId);
    const shortfall = entry.handoffId ? null : briefShortfall(brief, source?.estimatedTokens ?? 0);
    if (shortfall) {
      runtime.logWarn(`bridge: refused the compaction brief for ${sessionId} — ${shortfall}`);
      try {
        await runtime.cancelResumeNow(sessionId);
      } catch (error) {
        runtime.logWarn(`bridge: could not durably withdraw the refused compaction for ${sessionId} — ${error instanceof Error ? error.message : String(error)}`);
        return {
          status: 503,
          body: {
            error: 'resume_cancel_not_durable',
            retryable: true,
            message: 'The handoff was incomplete, but cancelling this compaction was not stored yet. Retrying…',
            sessionId,
            job: runtime.resumeJobFor(sessionId)
          }
        };
      }
      return {
        status: 409,
        body: {
          error: 'brief_incomplete',
          message: `${shortfall} Nothing was compacted — this chat still has its session.`,
          sessionId,
          job: runtime.resumeJobFor(sessionId)
        }
      };
    }
    const handoff = await runtime.attachSummary(token, brief);
    if (!handoff) {
      const after = runtime.continuationByToken(token);
      const retryable = after?.sessionId === sessionId && after.state === 'awaiting-summary';
      return {
        status: retryable ? 503 : 409,
        body: {
          error: 'brief_not_stored',
          ...(retryable ? { retryable: true } : {}),
          sessionId,
          job: runtime.resumeJobFor(sessionId)
        }
      };
    }
    const command = runtime.queueResumeCommand(sessionId, token);
    runtime.setPlacementCollector(conversationId);
    try {
      await runtime.deliver();
    } finally {
      runtime.setPlacementCollector(null);
    }
    runtime.logInfo(`bridge: captured the compaction brief for ${sessionId}; opening the replacement chat`);
    return {
      status: 200,
      body: {
        stored: true,
        sessionId,
        handoffId: handoff.id,
        commandId: command?.id ?? null,
        placement: runtime.pendingBrowserPlacement(conversationId),
        job: runtime.resumeJobFor(sessionId)
      }
    };
  }

  async function captureRecordedBrief(
    conversationId: string,
    token: string,
    anchor: string
  ): Promise<CaptureResult | null> {
    const entry = runtime.continuationByToken(token);
    if (!entry || entry.from !== conversationId || entry.state !== 'awaiting-summary' ||
        entry.sourceSend.state !== 'sent' || entry.sourceSend.messageId !== anchor ||
        runtime.runningToolCalls(conversationId) > 0) return null;
    const session = await runtime.getSession(entry.sessionId);
    if (session?.conversationId !== conversationId || (entry.automatic && !runtime.automaticCompactionAllowed(session))) return null;
    const response = await runtime.readHandoffResponse(entry.sessionId, conversationId, anchor, token);
    if (response.status === 'ambiguous') {
      runtime.noticeRefusal(`handoff-ambiguous:${token}`,
        `bridge: compaction ${token.slice(0, 8)} has more than one answer to its handoff request — not capturing either`);
    }
    if (response.status !== 'complete') return null;
    const current = runtime.continuationByToken(token);
    if (!current || current.state !== 'awaiting-summary' || current.sourceSend.state !== 'sent' ||
        current.sourceSend.messageId !== anchor) return null;
    return captureCompactionBrief(conversationId, current, response.text, session);
  }

  return { abortRejectedResume, captureCompactionBrief, captureRecordedBrief };
}
