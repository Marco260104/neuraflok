import { expect, it, vi } from 'vitest';
import type { ChatProgressRuntime } from '../frontend/features/chat/chat-progress-types.js';
import { createChatProgressStatus } from '../frontend/features/chat/chat-progress-status.js';
import { hasRecentTurnActivity, recordChatSelection } from '../frontend/features/chat/chat-turn-state.js';
import { t } from '../frontend/shared/i18n.js';

function progressRuntime(now: number, activityAt?: number): ChatProgressRuntime {
  const startedAt = now - 30 * 60_000;
  const events = [
    { kind: 'user_message', time: startedAt, turnId: 'turn-1', seq: 0, source: 'app',
      messageId: 'user-1', message: { text: 'Pregunta anterior', chars: 17, truncated: false } },
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
    const startedAt = now - 30 * 60_000;
    vi.setSystemTime(startedAt + 1_000);
    recordChatSelection('session-1', 3, startedAt - 1_000);
    const statusLine = createChatProgressStatus(progressRuntime(now));
    expect(statusLine.stateLine().working).toBe(true);
    vi.setSystemTime(now);
    const status = statusLine.stateLine();

    expect(status.text).toBe(t('Waiting for provider…'));
    expect(status.working).toBe(true);
    expect(status.ticking).not.toBe(true);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('keeps the working timer when the active turn has recent tool activity', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const startedAt = now - 30 * 60_000;
    vi.setSystemTime(startedAt + 1_000);
    recordChatSelection('session-1', 3, startedAt - 1_000);
    const statusLine = createChatProgressStatus(progressRuntime(now, now - 20_000));
    expect(statusLine.stateLine().working).toBe(true);
    vi.setSystemTime(now);
    const status = statusLine.stateLine();

    expect(status.text).toContain(t('Working'));
    expect(status.working).toBe(true);
    expect(status.ticking).toBe(true);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('does not revive Thinking from a restored turn start after its old answer', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'restored-turn';
    runtime.events = [
      { kind: 'user_message', time: now - 30_000, turnId: 'original-turn', seq: 1, source: 'app',
        messageId: 'user-1', message: { text: 'Pregunta anterior', chars: 17, truncated: false } },
      { kind: 'assistant_message', time: now - 29_000, turnId: 'original-turn', seq: 2, source: 'extension',
        messageId: 'answer-1', final: true, state: 'final', message: { text: 'Respuesta anterior', chars: 18, truncated: false } },
      { kind: 'turn_end', time: now - 29_000, turnId: 'original-turn', seq: 3, source: 'extension', outcome: 'completed' },
      { kind: 'turn_start', time: now - 500, turnId: 'restored-turn', seq: 4, source: 'extension' }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 29_000,
      lastTurnEndAt: now - 29_000,
      lastTurnOutcome: 'completed'
    });

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.working).not.toBe(true);
    expect(status.text).toBe('');
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('shows a turn start when its authored question was sent during this selection', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'new-turn';
    runtime.events = [
      { kind: 'user_message', time: now - 500, turnId: 'new-turn', seq: 1, source: 'app',
        messageId: 'user-2', message: { text: 'Pregunta nueva', chars: 14, truncated: false } },
      { kind: 'turn_start', time: now - 400, turnId: 'new-turn', seq: 2, source: 'extension' }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 30_000,
      lastTurnEndAt: now - 30_000,
      lastTurnOutcome: 'completed'
    });

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.working).toBe(true);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('keeps hidden provider context checks from reviving Thinking after chat navigation', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'warmup-turn';
    const warmupEvents = [
      { kind: 'user_message', time: now - 100, turnId: 'warmup-turn', seq: 4, source: 'extension',
        messageId: 'context-check', message: { text: 'NEURAFLOK_CONTEXT_CHECK This is a hidden readiness check.', chars: 57, truncated: false } },
      { kind: 'turn_start', time: now - 90, turnId: 'warmup-turn', seq: 5, source: 'extension' },
      { kind: 'progress', time: now - 10, turnId: 'warmup-turn', seq: 6, source: 'extension', label: 'Checking context…' }
    ] as unknown as ChatProgressRuntime['events'];
    runtime.events = warmupEvents;
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 30_000,
      lastTurnEndAt: now - 30_000,
      lastTurnOutcome: 'completed'
    });

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.working).not.toBe(true);
    expect(status.text).toBe('');
    expect(hasRecentTurnActivity(warmupEvents, 'warmup-turn', now - 1_000, now, new Set(), 'NEURAFLOK_WARMUP')).toBe(false);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});
