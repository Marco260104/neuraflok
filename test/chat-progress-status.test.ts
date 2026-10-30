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
    locallyStoppedTurn: null,
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

it('keeps Thinking visible through intermediate assistant finals and a temporary control gap', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now, now - 500);
    runtime.events = [
      ...runtime.events,
      { kind: 'assistant_message', time: now - 100, turnId: 'turn-1', seq: 3, source: 'extension',
        messageId: 'intermediate-final', final: true, state: 'final',
        message: { text: 'A step is complete; continuing the work.', chars: 39, truncated: false } }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, { activeTurnId: 'turn-1' });
    const statusLine = createChatProgressStatus(runtime);

    expect(statusLine.stateLine().working).toBe(true);
    // The page can momentarily omit both control and summary turn ids while it
    // dispatches the next step. That gap must not hide the current spinner.
    runtime.controlledTurnId = null;
    Object.assign(runtime.sessions[0]!, { activeTurnId: null });
    expect(statusLine.stateLine().working).toBe(true);
    expect(statusLine.stateLine().text).toContain(t('Working'));
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('keeps long work visible after a quiet intermediate final until an explicit turn end', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const startedAt = now - 5_000;
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, startedAt - 1_000);
    const runtime = progressRuntime(now);
    runtime.events = [
      { kind: 'user_message', time: startedAt, turnId: 'turn-1', seq: 0, source: 'app',
        messageId: 'user-1', message: { text: 'Termina el trabajo completo', chars: 27, truncated: false } },
      { kind: 'turn_start', time: startedAt + 10, turnId: 'turn-1', seq: 1, source: 'extension' },
      { kind: 'assistant_message', time: now - 1_000, turnId: 'turn-1', seq: 2, source: 'extension',
        messageId: 'intermediate-final', final: true, state: 'final',
        message: { text: 'Un paso está listo; sigo con el trabajo.', chars: 39, truncated: false } }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      finishTurn: { turnId: 'turn-1', startedAt },
      activeTurnId: 'turn-1',
      lastAssistantFinalAt: now - 1_000,
      lastTurnEndAt: null
    });
    const statusLine = createChatProgressStatus(runtime);

    expect(statusLine.stateLine().working).toBe(true);
    // The control snapshot can briefly disappear while a long task is quiet.
    runtime.controlledTurnId = null;
    Object.assign(runtime.sessions[0]!, { activeTurnId: null });
    vi.setSystemTime(now + 2 * 60_000);
    const quietStatus = statusLine.stateLine();
    expect(quietStatus.working).toBe(true);
    expect(quietStatus.text).toBe(t('Waiting for provider…'));

    const endedAt = Date.now();
    runtime.events = [
      ...runtime.events,
      { kind: 'turn_end', time: endedAt, turnId: 'turn-1', seq: 3, source: 'extension', outcome: 'completed' }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, { lastTurnEndAt: endedAt, activeTurnId: null });
    const completedStatus = statusLine.stateLine();
    expect(completedStatus.working).not.toBe(true);
    expect(completedStatus.text).toContain(t('Worked'));
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

it('keeps the live work state through a queued follow-up handoff', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'turn-1';
    runtime.events = [
      { kind: 'user_message', time: now - 10_000, turnId: 'turn-1', seq: 1, source: 'app',
        messageId: 'user-1', message: { text: 'Primera solicitud', chars: 17, truncated: false } },
      { kind: 'turn_start', time: now - 9_900, turnId: 'turn-1', seq: 2, source: 'extension' },
      { kind: 'assistant_message', time: now - 1_500, turnId: 'turn-1', seq: 3, source: 'extension',
        messageId: 'answer-1', final: true, state: 'final', message: { text: 'Terminado', chars: 9, truncated: false } },
      { kind: 'turn_end', time: now - 1_400, turnId: 'turn-1', seq: 4, source: 'extension', outcome: 'completed' }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 1_500,
      lastTurnEndAt: now - 1_400,
      activeTurnId: null,
      lastTurnOutcome: 'completed'
    });
    runtime.pendingComposerInputs = [{
      id: 'queued-2', sessionId: 'session-1', mode: 'after-turn', state: 'queued',
      dueAt: now - 100, createdAt: now - 100, text: 'Segunda solicitud', warmup: false
    } as unknown as ChatProgressRuntime['pendingComposerInputs'][number]];

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.text).toBe(t('Working…'));
    expect(status.working).toBe(true);
    expect(status.ticking).toBe(true);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('keeps work visible after a queued message is delivered but before its turn starts', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'turn-1';
    runtime.events = [
      { kind: 'user_message', time: now - 2_000, turnId: 'turn-1', seq: 1, source: 'app',
        messageId: 'user-1', message: { text: 'Primera solicitud', chars: 17, truncated: false } },
      { kind: 'turn_end', time: now - 1_000, turnId: 'turn-1', seq: 2, source: 'extension', outcome: 'completed' },
      { kind: 'user_message', time: now - 100, turnId: 'turn-2', inputId: 'queued-2', seq: 3, source: 'app',
        messageId: 'user-2', message: { text: 'Segunda solicitud', chars: 17, truncated: false } }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 1_000,
      lastTurnEndAt: now - 1_000,
      activeTurnId: null,
      lastTurnOutcome: 'completed'
    });
    runtime.pendingComposerInputs = [{
      id: 'queued-2', sessionId: 'session-1', mode: 'after-turn', state: 'sent',
      dueAt: now - 200, createdAt: now - 200, deliveredAt: now - 100, text: 'Segunda solicitud', warmup: false
    } as unknown as ChatProgressRuntime['pendingComposerInputs'][number]];

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.text).toBe(t('Working…'));
    expect(status.working).toBe(true);
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});

it('ends the handoff animation when the queued turn reaches a terminal event', () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    vi.setSystemTime(now);
    recordChatSelection('session-1', 3, now - 1_000);
    const runtime = progressRuntime(now);
    runtime.controlledTurnId = 'turn-2';
    runtime.events = [
      { kind: 'user_message', time: now - 2_000, turnId: 'turn-1', seq: 1, source: 'app',
        messageId: 'user-1', message: { text: 'Primera solicitud', chars: 17, truncated: false } },
      { kind: 'turn_end', time: now - 1_500, turnId: 'turn-1', seq: 2, source: 'extension', outcome: 'completed' },
      { kind: 'user_message', time: now - 1_000, turnId: 'turn-2', inputId: 'queued-2', seq: 3, source: 'app',
        messageId: 'user-2', message: { text: 'Segunda solicitud', chars: 17, truncated: false } },
      { kind: 'turn_start', time: now - 900, turnId: 'turn-2', seq: 4, source: 'extension' },
      { kind: 'assistant_message', time: now - 100, turnId: 'turn-2', seq: 5, source: 'extension',
        messageId: 'answer-2', final: true, state: 'final', message: { text: 'Listo', chars: 5, truncated: false } },
      { kind: 'turn_end', time: now - 90, turnId: 'turn-2', seq: 6, source: 'extension', outcome: 'completed' }
    ] as unknown as ChatProgressRuntime['events'];
    Object.assign(runtime.sessions[0]!, {
      lastAssistantFinalAt: now - 100,
      lastTurnEndAt: now - 90,
      activeTurnId: 'turn-2',
      lastTurnOutcome: 'completed'
    });
    runtime.pendingComposerInputs = [{
      id: 'queued-2', sessionId: 'session-1', mode: 'after-turn', state: 'sent',
      dueAt: now - 2_000, createdAt: now - 2_000, deliveredAt: now - 1_000,
      text: 'Segunda solicitud', historyAnchored: true, warmup: false
    } as unknown as ChatProgressRuntime['pendingComposerInputs'][number]];

    const status = createChatProgressStatus(runtime).stateLine();

    expect(status.working).not.toBe(true);
    expect(status.text).toContain(t('Worked'));
  } finally {
    recordChatSelection(null, -1, 0);
    vi.useRealTimers();
  }
});
