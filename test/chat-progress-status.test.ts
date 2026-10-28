import { expect, it, vi } from 'vitest';
import type { ChatProgressRuntime } from '../frontend/features/chat/chat-progress-types.js';
import { createChatProgressStatus } from '../frontend/features/chat/chat-progress-status.js';
import { t } from '../frontend/shared/i18n.js';

function progressRuntime(now: number, activityAt?: number): ChatProgressRuntime {
  const startedAt = now - 30 * 60_000;
  const events = [
    { kind: 'turn_start', time: startedAt, turnId: 'turn-1', seq: 1, source: 'extension' },
    ...(activityAt === undefined ? [] : [{
      kind: 'tool_call', time: activityAt, turnId: 'turn-1', seq: 2, source: 'mcp',
      call: { callId: 'call-1', tool: 'read', arguments: {}, status: 'completed' }
    }])
  ];
  return {
    api: {} as ChatProgressRuntime['api'],
    selectedId: 'session-1',
    selectedProjectId: null,
    pendingNewInput: null,
    selectionGeneration: 3,
    controlledSessionId: 'session-1',
    controlledSelection: 3,
    controlledTurnId: 'turn-1',
    goalWaitView: null,
    events: events as unknown as ChatProgressRuntime['events'],
    startingInputs: new Map(),
    pendingComposerInputs: [],
    sessions: [{
      id: 'session-1',
      finishTurn: { turnId: 'turn-1', startedAt },
      lastToolCallAt: activityAt ?? null,
      lastAssistantFinalAt: null,
      lastTurnEndAt: null
    } as unknown as ChatProgressRuntime['sessions'][number]],
    detailFor: 'session-1',
    swarm: null,
    durationTimer: undefined,
    visible: true,
    badgeKey: '',
    state: () => ({ config: { ui: { developerMode: false } } }) as unknown as ReturnType<ChatProgressRuntime['state']>,
    sessionBadges: () => [],
    paintSessions: () => undefined,
    paintRecoveryStatus: () => false,
    paintGoalProgress: () => undefined
  };
}

it('stops showing an elapsed working timer when an open turn has gone quiet', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    const status = createChatProgressStatus(progressRuntime(now)).stateLine();

    expect(status.text).toBe(t('Waiting for provider…'));
    expect(status.working).toBe(true);
    expect(status.ticking).not.toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the working timer when the active turn has recent tool activity', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    const status = createChatProgressStatus(progressRuntime(now, now - 20_000)).stateLine();

    expect(status.text).toContain(t('Working'));
    expect(status.working).toBe(true);
    expect(status.ticking).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
