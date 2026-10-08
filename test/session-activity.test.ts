import { describe, expect, it } from 'vitest';
import { CHAT_ACTIVE_MS, type SessionSummary } from '../contracts/session.js';
import { recentChatActivity, sessionWorkingAt, workerReportedFinish } from '../contracts/sessions/activity-state.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    startedAt: 100,
    lastToolCallAt: null,
    lastAssistantFinalAt: null,
    lastTurnEndAt: null,
    activityExpiresAt: undefined,
    lastFinishReportAt: undefined,
    origin: null,
    ...overrides
  } as SessionSummary;
}

const workerOrigin = { kind: 'worker', fromSessionId: 'parent', agentId: 'worker-1', task: 'task' } as const;

describe('session activity', () => {
  it('uses a projected deadline when present and falls back only when absent', () => {
    const projected = session({
      lastAssistantFinalAt: 200,
      activityExpiresAt: 500
    });
    expect(recentChatActivity(projected, 499)).toBe(true);
    expect(recentChatActivity(projected, 500)).toBe(false);
    expect(recentChatActivity({ ...projected, activityExpiresAt: null }, 101)).toBe(false);
    expect(recentChatActivity({ ...projected, activityExpiresAt: undefined }, 101)).toBe(false);
  });

  it('requires newer work than the latest finish and expires at the active-window boundary', () => {
    expect(recentChatActivity(session(), 100)).toBe(true);
    expect(recentChatActivity(session({ lastAssistantFinalAt: 100 }), 100)).toBe(false);
    expect(recentChatActivity(session({ lastToolCallAt: 101, lastTurnEndAt: 100 }), 101)).toBe(true);
    expect(recentChatActivity(session(), 100 + CHAT_ACTIVE_MS)).toBe(false);
  });

  it('ends worker activity only when its finish report follows its latest tool call', () => {
    const finished = session({ origin: workerOrigin, lastToolCallAt: 20, lastFinishReportAt: 20 });
    expect(workerReportedFinish(finished)).toBe(true);
    expect(sessionWorkingAt(finished, 100)).toBe(false);
    expect(workerReportedFinish(session({ origin: workerOrigin, lastToolCallAt: 20, lastFinishReportAt: 19 }))).toBe(false);
    expect(workerReportedFinish(session({ lastFinishReportAt: 20 }))).toBe(false);
  });
});
