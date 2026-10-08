import {
  appendEvent,
  closeConversation,
  createSession,
  flushSessions,
  fs,
  getSession,
  liveConversations,
  readEvents,
  recordChatObservations,
  resetSessionStoreForTests,
  sessionForConversation,
  upsertMessageEvent,
} from './context.js';
import type {
  SessionEvent,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('session store', () => {
  it('keeps running counters and a token estimate on the summary', async () => {
      const summary = await createSession({ title: 'counters' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
      });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'chat_error',
        message: { text: 'something broke', truncated: false, chars: 15 }
      });
      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', outcome: 'interrupted' });

      const after = await getSession(summary.id);
      expect(after?.userMessages).toBe(1);
      expect(after?.errors).toBe(1);
      expect(after?.lastTurnOutcome).toBe('interrupted');
      expect(after?.estimatedTokens).toBeGreaterThanOrEqual(100);
    });

  it('keeps the exact last attributed tool-call time separate from unrelated session activity', async () => {
      const summary = await createSession({ title: 'tool activity clock' });
      const toolAt = summary.startedAt + 20;
      const laterAt = summary.startedAt + 90;
      await appendEvent(summary.id, {
        time: toolAt,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-tool-clock',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr-tool-clock',
          conversationId: 'c-tool-clock',
          attributionMethod: 'request_id',
          args: { text: '{"paths":["/project/a.ts"]}', truncated: false, chars: 27 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
        }
      });
      // A repaired historical call can be appended later even though it started earlier. It counts as an action, but it must not replace the latest-activity projection.
      await appendEvent(summary.id, {
        time: toolAt - 5,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-tool-clock-older',
          tool: 'find',
          attribution: 'request_id',
          requestId: 'wfr-tool-clock-older',
          conversationId: 'c-tool-clock',
          attributionMethod: 'request_id',
          args: { text: '{"query":"older"}', truncated: false, chars: 17 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { title: 'Searched older history', tone: 'neutral', kind: 'search' }
        }
      });
      await appendEvent(summary.id, {
        time: laterAt,
        source: 'extension',
        kind: 'note',
        message: { text: 'later but not a tool call', truncated: false, chars: 25 }
      });

      expect(await getSession(summary.id)).toMatchObject({
        updatedAt: laterAt,
        toolCalls: 2,
        lastToolCallAt: toolAt,
        lastToolActivity: { kind: 'read', title: 'Read a.ts' }
      });
      await flushSessions();
      resetSessionStoreForTests();
      expect(await getSession(summary.id)).toMatchObject({
        toolCalls: 2,
        lastToolCallAt: toolAt,
        lastToolActivity: { kind: 'read', title: 'Read a.ts' }
      });
    });

  /** A stopped turn has no final assistant message, so it never moved the activity boundary and a blocked, stopped prime kept its `active` badge on the refused call before the stop. */
    it('projects any turn end, a stop included, as an end of recent tool activity', async () => {
      const summary = await createSession({ title: 'turn end boundary' });
      expect((await getSession(summary.id))?.lastTurnEndAt).toBeNull();
      await appendEvent(summary.id, { time: 300, source: 'extension', kind: 'turn_start', turnId: 'g-stop' });
      await appendEvent(summary.id, {
        time: 400,
        source: 'extension',
        kind: 'turn_end',
        turnId: 'g-stop',
        outcome: 'stopped'
      });
      expect((await getSession(summary.id))?.lastTurnEndAt).toBe(400);
    });

  it('projects a stable final assistant message as the exact end of recent tool activity', async () => {
      const summary = await createSession({ title: 'final activity boundary' });
      const messageId = 'assistant-final-activity-boundary';
      await upsertMessageEvent(summary.id, {
        time: 100,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message: { text: 'Still working', truncated: false, chars: 13 },
        state: 'streaming',
        final: false
      });
      expect((await getSession(summary.id))?.lastAssistantFinalAt).toBeNull();

      await upsertMessageEvent(summary.id, {
        time: 200,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message: { text: 'Finished.', truncated: false, chars: 9 },
        state: 'final',
        final: true
      });

      expect((await getSession(summary.id))?.lastAssistantFinalAt).toBe(200);
    });

  it('projects a successful worker finish report as the session finish boundary', async () => {
      const summary = await createSession({ title: 'finish boundary' });
      const call = (callId: string, tool: string, finish: boolean) => ({
        callId,
        tool,
        attribution: 'exact',
        requestId: callId,
        conversationId: 'conv-finish',
        attributionMethod: 'request_id',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'agent', tone: 'good', title: 'Reported the finished task' },
        ...(finish ? { endsActivity: true } : {})
      });
      await appendEvent(summary.id, { time: 300, source: 'mcp', kind: 'tool_call', call: call('c-work', 'read', false) } as SessionEvent);
      expect((await getSession(summary.id))?.lastFinishReportAt).toBeNull();

      await appendEvent(summary.id, { time: 400, source: 'mcp', kind: 'tool_call', call: call('c-finish', 'agents', true) } as SessionEvent);
      const after = await getSession(summary.id);
      expect(after?.lastFinishReportAt).toBe(400);
      expect(after?.lastToolCallAt).toBe(400);
    });

  it('keeps the open turn open when the provider page detaches mid-turn', async () => {
      const conversationId = 'c-detach-keeps-turn-open';
      const opened = await recordChatObservations(conversationId, [
        { kind: 'user_message', time: 10, text: 'run the long job', messageId: 'detach-user-1' },
        { kind: 'turn_start', time: 11, turnId: 'g-detach-open' }
      ]);
      const sessionId = opened.sessionId!;

      await closeConversation(conversationId);

      // A detach is not evidence about the turn. It may not end it, and it may not end it "unknown" either: an ended turn is unreachable for the recovery that follows.
      expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual([]);
      const notes = await readEvents(sessionId, { kinds: ['note'] });
      expect(notes).toHaveLength(1);
      expect(notes[0]?.turnId).toBe('g-detach-open');

      const reopened = await recordChatObservations(conversationId, [
        { kind: 'turn_end', time: 30, turnId: 'g-detach-open', outcome: 'completed' }
      ]);
      expect(reopened.sessionId).toBe(sessionId);
      const ends = await readEvents(sessionId, { kinds: ['turn_end'] });
      expect(ends.map((event) => event.kind === 'turn_end' && event.outcome)).toEqual(['completed']);
    });

  it.each(['completed', 'stopped'] as const)('does not restore an abandoned older turn after the latest turn %s', async (outcome) => {
      const conversationId = `c-restore-latest-terminal-${outcome}`;
      const opened = await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 10, turnId: 'g-abandoned' },
        { kind: 'turn_start', time: 20, turnId: 'g-latest' },
        { kind: 'turn_end', time: 30, turnId: 'g-latest', outcome }
      ]);
      for (let attempt = 0; attempt < 4; attempt++) {
        await closeConversation(conversationId);
        await sessionForConversation(conversationId);
        expect(liveConversations().find(entry => entry.conversationId === conversationId)).toMatchObject({
          generating: false, activeTurnId: null
        });
      }
      // The older incomplete history is preserved without inventing a terminal for it.
      expect((await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).map(event => event.turnId)).toEqual(['g-latest']);
    });

  it('restores the latest committed start without promoting an older orphan by timestamp', async () => {
      const conversationId = 'c-restore-latest-start';
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 100, turnId: 'g-orphan-clock-ahead' },
        { kind: 'turn_start', time: 20, turnId: 'g-current' },
        { kind: 'turn_end', time: 110, turnId: 'g-orphan-clock-ahead', outcome: 'completed' }
      ]);
      await closeConversation(conversationId);
      await sessionForConversation(conversationId);
      expect(liveConversations().find(entry => entry.conversationId === conversationId)).toMatchObject({
        generating: true, activeTurnId: 'g-current'
      });
    });

  it('offers a stable final reply to Goal after reload lost an uncertain turn identity', async () => {
      const conversationId = 'c-goal-final-after-reload';
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 10, turnId: 'g-before-reload' },
        { kind: 'turn_end', time: 20, turnId: 'g-before-reload', outcome: 'unknown' }
      ]);

      const recovered = await recordChatObservations(conversationId, [{
        kind: 'assistant_message',
        // ChatGPT may stamp the assistant object when generation starts, before a later detach.
        time: 15,
        messageId: 'assistant-stable-after-reload',
        text: 'The complete final answer that appeared after reload.',
        state: 'final',
        final: true
      }]);

      expect(recovered.goalCandidates).toEqual([{
        replyId: 'assistant-stable-after-reload',
        turnId: 'reply:assistant-stable-after-reload',
        eventSeq: expect.any(Number)
      }]);

      const replayed = await recordChatObservations(conversationId, [{
        kind: 'assistant_message',
        time: 15,
        messageId: 'assistant-stable-after-reload',
        text: 'The complete final answer that appeared after reload.',
        state: 'final',
        final: true
      }]);
      expect(replayed.goalCandidates).toEqual(recovered.goalCandidates);
      const [storedFinal] = await readEvents(recovered.sessionId!, { kinds: ['assistant_message'] });
      expect(storedFinal?.kind === 'assistant_message' && storedFinal.goalEligible).toBe(true);
    });

  it('does not turn a historical final answer into Goal work merely because a chat was opened', async () => {
      const conversationId = 'c-goal-historical-final';
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 100, turnId: 'g-newer-uncertain' },
        { kind: 'turn_end', time: 200, turnId: 'g-newer-uncertain', outcome: 'unknown' }
      ]);
      const recovered = await recordChatObservations(conversationId, [{
        kind: 'assistant_message',
        time: 30,
        messageId: 'assistant-historical-final',
        text: 'An answer from an already idle chat.',
        state: 'final',
        final: true
      }]);

      expect(recovered.goalCandidates).toEqual([]);
    });

  it('uses the stable final when it and the uncertain end arrive in the same browser batch', async () => {
      const recovered = await recordChatObservations('c-goal-final-same-batch', [
        { kind: 'turn_start', time: 10, turnId: 'g-same-batch' },
        {
          kind: 'assistant_message',
          time: 15,
          messageId: 'assistant-final-same-batch',
          text: 'Complete despite the page losing its finish edge.',
          state: 'final',
          final: true
        },
        { kind: 'turn_end', time: 20, turnId: 'g-same-batch', outcome: 'unknown' }
      ]);

      expect(recovered.goalCandidates).toEqual([expect.objectContaining({
        replyId: 'assistant-final-same-batch',
        turnId: 'reply:assistant-final-same-batch'
      })]);
    });

  it('does not spend an earlier uncertain boundary while a newer turn is still open', async () => {
      const conversationId = 'c-goal-newer-turn-open';
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 10, turnId: 'g-old-uncertain' },
        { kind: 'turn_end', time: 20, turnId: 'g-old-uncertain', outcome: 'unknown' }
      ]);
      const current = await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: 30, turnId: 'g-new-open' },
        {
          kind: 'assistant_message',
          time: 35,
          messageId: 'assistant-while-new-open',
          text: 'Do not decide this turn before its own terminal boundary.',
          state: 'final',
          final: true
        }
      ]);

      expect(current.goalCandidates).toEqual([]);
    });

  it('does not advance seq or summary state when the durable append fails', async () => {
      const summary = await createSession({ title: 'append failure is not an event' });
      const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
      try {
        await expect(
          appendEvent(summary.id, {
            time: 10,
            source: 'extension',
            kind: 'user_message',
            message: { text: 'phantom', truncated: false, chars: 7 }
          })
        ).rejects.toThrow('disk full');
      } finally {
        append.mockRestore();
      }

      const afterFailure = await getSession(summary.id);
      expect(afterFailure?.events).toBe(0);
      expect(afterFailure?.userMessages).toBe(0);
      expect(await readEvents(summary.id)).toHaveLength(0);

      const written = await appendEvent(summary.id, {
        time: 11,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'real', truncated: false, chars: 4 }
      });
      expect(written.seq).toBe(1);
      expect((await getSession(summary.id))?.events).toBe(1);
    });
});
