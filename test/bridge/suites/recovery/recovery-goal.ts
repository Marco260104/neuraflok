import { beforeEach, describe, expect, it, pair, vi } from '../../test-context.js';
import { attributed, events, maintenance, openTurn } from './recovery-fixtures.js';
import { resetRecoveryFixture } from './recovery-fixtures.js';

describe('unattributed activity recovery', () => {
  beforeEach(resetRecoveryFixture);
  /** A reload that worked is not a spent remedy. The budget is charged to the question, and the question does not move while one long answer runs. Measured 2026-09-26: a reload at 17:44 resumed a prime for ten minutes of tool calls, the stream dropped again at 17:58, and the chat was left on "Resume stream unavailable" for good because the answer had "already spent its error reload". */
    it('gives an answer its error reload back once the reload brought it back to work', async () => {
      vi.useFakeTimers();
      try {
        const RESUMED = 'dcdc0505-1111-2222-3333-444444444444';
        const drop = () => events(RESUMED, [{
          kind: 'chat_error', time: Date.now(), text: 'Resume stream unavailable', turnId: 'turn-long', recoverable: true
        }]);
        await pair();
        await events(RESUMED, [
          { kind: 'user_message', messageId: 'long-question', text: 'Work through the backlog', time: Date.now() },
          openTurn('turn-long')
        ]);
        await drop();
        const first = await maintenance();
        expect(first?.reason).toBe('assistant-error');
        await maintenance(first!.token, 'reloaded');
  
        // The same failure straight back, with nothing done in between: the reload bought nothing.
        await drop();
        expect(await maintenance(), 'no second reload without work in between').toBeNull();
  
        // The reload brought the answer back: ten minutes later, as measured, and past the shared reload cooldown, it is still calling local tools when the stream drops again.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await attributed(RESUMED, false, Date.now());
        await drop();
        expect((await maintenance())?.reason, 'a reload that led to real work earns the next one').toBe('assistant-error');
      } finally {
        vi.useRealTimers();
      }
    });
  
  it('earns a finished answer no reload, whatever its stream reports afterwards', async () => {
      vi.useFakeTimers();
      try {
        const RESUMED = 'dcdc0606-1111-2222-3333-444444444444';
        const drop = () => events(RESUMED, [{
          kind: 'chat_error', time: Date.now(), text: 'Resume stream unavailable', turnId: 'turn-long', recoverable: true
        }]);
        await pair();
        await events(RESUMED, [
          { kind: 'user_message', messageId: 'long-question', text: 'Work through the backlog', time: Date.now() },
          openTurn('turn-long')
        ]);
        await drop();
        const first = await maintenance();
        expect(first?.reason).toBe('assistant-error');
        await maintenance(first!.token, 'reloaded');
  
        // The same failure straight back, with nothing done in between: the reload bought nothing.
        await drop();
        expect(await maintenance(), 'no second reload without work in between').toBeNull();
  
        // The reload brought the answer back: ten minutes later, as measured, and past the shared reload cooldown, it is still calling local tools when the stream drops again.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await attributed(RESUMED, false, Date.now());
        // Measured 2026-09-26: the prime's complete final report, then "Resume stream unavailable" three minutes later about a stream that had nothing left to resume.
        await events(RESUMED, [{ kind: 'assistant_message', time: Date.now(), turnId: 'turn-long', messageId: 'long-final',
          text: 'The audit is complete.', state: 'final', final: true }]);
        await drop();
        expect(await maintenance(), 'a finished answer is not broken').toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
});
