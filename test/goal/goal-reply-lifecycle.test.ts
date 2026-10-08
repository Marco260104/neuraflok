import {
  appendEvent,
  createSession,
  decision,
  delta,
  goal,
  settled,
  stream,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('the reply', () => {
  const seed = async (conversationId: string): Promise<string> => {
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'ship it', truncated: false, chars: 7 }
    });
    return session.id;
  };

  /** A chunk can split an SSE line anywhere. The version that assumed chunk boundaries were line boundaries dropped whichever token happened to straddle one — which is invisible until a message arrives with a word missing out of the middle of it. */
  it('survives a chunk that splits a line in half', async () => {
    const sessionId = await seed('c-split');
    globalThis.fetch = (async () =>
      stream([
        'data: {"choices":[{"delta":{"content":"can you ',
        'also"}}]}\n' + delta(' add the flag'),
        'data: [DONE]\n'
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-split', turnId: 'g-1' });
    expect((await settled('c-split')).reply).toBe('can you also add the flag');
  });

  it('keeps the final SSE record when the stream closes without a trailing newline', async () => {
    const sessionId = await seed('c-eof');
    const lastRecord = `data: ${JSON.stringify({ choices: [{ delta: { content: 'last token survives' } }] })}`;
    globalThis.fetch = (async () => stream([lastRecord])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-eof', turnId: 'g-1' });
    const view = await settled('c-eof');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('last token survives');
  });

  it('treats the SSE DONE marker as terminal and ignores records after it', async () => {
    const sessionId = await seed('c-done-terminal');
    globalThis.fetch = (async () =>
      stream([
        delta('keep this reply'),
        'data: [DONE]\n',
        // A provider/proxy bug or buffered junk after the terminal record is not another part of this completion. Accepting it means the app can type text the model emitted after OpenAI-compatible streaming already declared the response complete.
        delta(' and never append this')
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-done-terminal', turnId: 'g-1' });
    const view = await settled('c-done-terminal');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('keep this reply');
  });

  it('fails a partial completion when the provider emits a streamed error', async () => {
    const sessionId = await seed('c-stream-error');
    globalThis.fetch = (async () =>
      stream([
        delta('this is only a partial instruction'),
        `data: ${JSON.stringify({ error: { message: 'upstream provider failed' } })}\n`,
        'data: [DONE]\n'
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-stream-error', turnId: 'g-1' });
    const view = await settled('c-stream-error');
    expect(view.stage).toBe('failed');
    expect(view.reply).toBe('');
    expect(view.error).toMatch(/stream|provider|request_failed/i);
  });

  /** One draft is one request, and a failure is not an answer. The two answers that end a Goal run are `[no reply]` and words to type. A dead socket, a try-later status, a stream that breaks and a reply this app cannot read are all the same event — no answer — so none of them may spend the turn: the draft settles `failed` and `retryable`, which is the page loop being told the turn is still owed one. Asking again is that loop's job, because only it can still see whether this is the turn being answered. */
  it('asks once per draft, and leaves an unanswered turn still owed an answer', async () => {
    const cases: Array<[string, () => unknown]> = [
      ['socket', () => { throw new TypeError('fetch failed'); }],
      ['408', () => new Response('{}', { status: 408 })],
      ['429', () => new Response('{}', { status: 429 })],
      ['503', () => new Response('{}', { status: 503 })],
      ['broken-stream', () => stream([delta('half an instruction'), `data: ${JSON.stringify({ error: { message: 'upstream provider failed' } })}\n`, 'data: [DONE]\n'])],
      ['malformed', () => stream([delta('unfinished thought'), 'data: {not-json}\n'])],
      ['oversize', () => stream([delta('x'.repeat(12_001)), 'data: [DONE]\n'])]
    ];
    for (const [name, fail] of cases) {
      const id = `c-unanswered-${name}`;
      const sessionId = await seed(id);
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return fail();
      }) as never;

      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(attempts, name).toBe(1);
      expect(view.stage, name).toBe('failed');
      expect(view.retryable, name).toBe(true);
      // Whatever arrived before the failure was never an answer, and never becomes one.
      expect(view.reply, name).toBe('');
    }
  });

  /** A refused key, an empty account or a model id nobody knows answers the same way twice. */
  it('asks once about a failure the same request would only repeat', async () => {
    const cases: Array<[string, () => unknown]> = [
      ['auth', () => new Response('{}', { status: 401 })],
      ['credit', () => new Response('{}', { status: 402 })],
      ['unknown-model', () => new Response('{}', { status: 404 })]
    ];
    for (const [name, fail] of cases) {
      const id = `c-terminal-${name}`;
      const sessionId = await seed(id);
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return fail();
      }) as never;

      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(attempts, name).toBe(1);
      expect(view.stage, name).toBe('failed');
      expect(view.retryable, name).toBe(false);
    }
  });

  /** The one retry authority, exercised end to end: ack the failure, ask again, same turn. This is exactly what the page's Goal loop does, and the idempotency that stops a second message has to keep letting it through — nothing was typed, so this is still the first message for that turn rather than a second one. */
  it('draws a new draft for the same turn once the page has retired the failed one', async () => {
    const sessionId = await seed('c-again');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('{}', { status: 503 })
        : stream([delta('the real instruction'), 'data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' });
    const failure = await settled('c-again');
    expect(failure.stage).toBe('failed');
    expect(failure.retryable).toBe(true);

    // Unread, the failure is still the page's to see: asking again hands back the same one.
    expect(goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' }).stage).toBe('failed');
    expect(attempts).toBe(1);

    expect(goal.ackGoalDraft('c-again', failure.token)).toBe(true);
    goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' });
    const view = await settled('c-again');
    expect(attempts).toBe(2);
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('the real instruction');
  });

  /** …and never for a failure that would only be paid for again. */
  it('refuses a fresh attempt at a turn whose failure was settings, not weather', async () => {
    const sessionId = await seed('c-again-settled');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('{}', { status: 402 });
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-again-settled', turnId: 'g-1' });
    const failure = await settled('c-again-settled');
    expect(failure.retryable).toBe(false);
    expect(goal.ackGoalDraft('c-again-settled', failure.token)).toBe(true);

    const again = goal.startGoalDraft({ sessionId, conversationId: 'c-again-settled', turnId: 'g-1' });
    expect(again.stage).toBe('failed');
    expect(attempts).toBe(1);
  });

  /** The loop's stopping condition, and the whole reason it can be left running. */
  it('stops calling a draft busy once the page retired it mid-request', async () => {
    const id = 'c-retired-mid-request';
    const sessionId = await seed(id);
    let release: (() => void) | null = null;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return decision('continue', 'carry on');
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
    expect(goal.goalDraftBusy(id)).toBe(true);
    // Retired while the request is still out: run() returns without settling the stage. The owed-goal inspection asks this question to decide whether to nudge the chat again, and "busy forever" meant it never did.
    expect(goal.retireGoalDraftsFor(id)).toBe(true);
    expect(goal.goalDraftBusy(id)).toBe(false);
    (release as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(goal.goalDraftBusy(id)).toBe(false);
  });

  it('sends nothing when the model says the goal is met', async () => {
    const sessionId = await seed('c-done');
    globalThis.fetch = (async () => stream([delta('NO_REPLY'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-done', turnId: 'g-1' });
    const view = await settled('c-done');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  it('keeps "the goal is met" as the run outcome for the app window after the page acts on it', async () => {
    const sessionId = await seed('c-met');
    globalThis.fetch = (async () => stream([delta('NO_REPLY'), 'data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-met', turnId: 'g-1' });
    const view = await settled('c-met');
    expect(goal.goalOutcomeFor('c-met'), 'nothing to report before the page acts on it').toBeNull();
    expect(goal.ackGoalDraft('c-met', view.token)).toBe(true);
    // The page is done with it, so its own view goes quiet...
    expect(goal.goalViewFor('c-met')).toBeNull();
    // ...but the window still learns that this run ended with the goal met.
    expect(goal.goalOutcomeFor('c-met')).toMatchObject({ stage: 'no-reply', turnId: 'g-1', reply: '' });
  });

  /** "The goal is met" needs nothing typed, so it must not wait for a page to come and act on it. Seen live on Windows (2026-10-05): the chat's tab closed while the model was deciding, its NO_REPLY was never acknowledged, the app restarted and lost the in-memory draft, and the turn stayed owed for the ledger's twelve hours, the Goal row spinning "Answer settling". */
  it('settles the owed turn as soon as the model says the goal is met, even if no page acknowledges it', async () => {
    const sessionId = await seed('c-met-unacked');
    await goal.acceptGoalReplyNow({
      conversationId: 'c-met-unacked', sessionId, replyId: 'assistant-met-unacked', turnId: 'g-met', eventSeq: 3, blocked: false
    });
    globalThis.fetch = (async () => stream([delta('NO_REPLY'), 'data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-met-unacked', turnId: 'g-met' });
    expect((await settled('c-met-unacked')).stage).toBe('no-reply');

    expect(goal.goalPendingReplyFor('c-met-unacked')).toBeNull();
    expect(goal.pendingGoalReplies().map(owed => owed.conversationId)).not.toContain('c-met-unacked');
    const saved = goal.snapshotGoalReplies();
    expect(saved.replies).toContainEqual(expect.objectContaining({ replyId: 'assistant-met-unacked', state: 'handled' }));
    goal.resetGoalStateForTests();
    goal.restoreGoalReplies(saved);
    expect(goal.goalPendingReplyFor('c-met-unacked'), 'still settled after a restart').toBeNull();
  });

  it('keeps the turn owed while a continuation waits to be typed', async () => {
    const sessionId = await seed('c-typed-owed');
    await goal.acceptGoalReplyNow({
      conversationId: 'c-typed-owed', sessionId, replyId: 'assistant-typed-owed', turnId: 'g-typed', eventSeq: 3, blocked: false
    });
    globalThis.fetch = (async () => decision('continue', 'what about the tests')) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-typed-owed', turnId: 'g-typed' });
    expect((await settled('c-typed-owed')).stage).toBe('ready');
    // Only the page can type it; until it says it did, the turn is still owed.
    expect(goal.goalPendingReplyFor('c-typed-owed')).toMatchObject({ turnId: 'g-typed' });
  });

  it('reports no outcome for a typed continuation the page has acted on', async () => {
    const sessionId = await seed('c-typed');
    globalThis.fetch = (async () => decision('continue', 'what about the tests')) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-typed', turnId: 'g-1' });
    const view = await settled('c-typed');
    expect(view.stage).toBe('ready');
    expect(goal.ackGoalDraft('c-typed', view.token)).toBe(true);
    expect(goal.goalOutcomeFor('c-typed')).toBeNull();
  });

  /** Protocol words are never safe composer prose; ambiguity stops instead of self-prompting. */
  it('fails closed when legacy output wraps NO_REPLY in scratchpad prose', async () => {
    const sessionId = await seed('c-mentions');
    globalThis.fetch = (async () =>
      stream([delta('⑥ Counting flush: ~50 NO_REPLY'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-mentions', turnId: 'g-1' });
    const view = await settled('c-mentions');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  it('accepts a strict structured continuation and strips tokenizer wrappers', async () => {
    const sessionId = await seed('c-structured-continue');
    globalThis.fetch = (async () => decision('continue', '<|begin_of_sentence|>what about the tests')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-structured-continue', turnId: 'g-1' });
    const view = await settled('c-structured-continue');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('what about the tests');
    expect(view.reply).not.toContain('<|');
  });

  it('accepts a strict structured stop decision', async () => {
    const sessionId = await seed('c-structured-stop');
    globalThis.fetch = (async () => decision('stop')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-structured-stop', turnId: 'g-1' });
    const view = await settled('c-structured-stop');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  it('never types a structured reply made only of tokenizer control markers', async () => {
    const sessionId = await seed('c-control-only');
    globalThis.fetch = (async () => decision('continue', '<|begin_of_sentence|>')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-control-only', turnId: 'g-1' });
    const view = await settled('c-control-only');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('control_tokens_only');
    expect(view.reply).toBe('');
  });

  it('rejects non-schema content in a normal OpenRouter completion envelope', async () => {
    const sessionId = await seed('c-non-schema');
    globalThis.fetch = (async () =>
      Response.json({ choices: [{ message: { content: 'random provider scratchpad' } }] })) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-non-schema', turnId: 'g-1' });
    const view = await settled('c-non-schema');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('invalid_goal_decision_json');
    expect(view.reply).toBe('');
  });

  /** What a routed provider actually sent on 2026-09-03, three drafts in a row: the decision, with its thinking in front of it despite `reasoning.exclude`. Each one failed as `invalid_goal_decision_json` and the page asked again at once, which is a key being spent on a reply the app already had. Only the wrapping is removed; the object is validated as strictly as before. */
  it('reads the decision out from behind a reasoning block, a fence, or a sentence', async () => {
    const shapes = [
      '<think>The user wants the next step.\nCounting: {done: false}</think>\n{"action":"continue","reply":"Run the tests next."}',
      '```json\n{"action":"continue","reply":"Run the tests next."}\n```',
      'Here is the decision:\n{"action":"continue","reply":"Run the tests next."}\nDone.'
    ];
    for (const [index, content] of shapes.entries()) {
      const conversationId = `c-wrapped-${index}`;
      const sessionId = await seed(conversationId);
      globalThis.fetch = (async () => Response.json({ choices: [{ message: { content } }] })) as never;
      goal.startGoalDraft({ sessionId, conversationId, turnId: 'g-1' });
      const view = await settled(conversationId);
      expect(view.stage, content).toBe('ready');
      expect(view.reply).toBe('Run the tests next.');
    }
  });

  it('still refuses a reply whose only braces are not the decision', async () => {
    const sessionId = await seed('c-braces-only');
    globalThis.fetch = (async () =>
      Response.json({ choices: [{ message: { content: '<think>{"note":"scratch"}</think> nothing else' } }] })) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-braces-only', turnId: 'g-1' });
    const view = await settled('c-braces-only');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('invalid_goal_decision_json');
  });

  it('accepts the stopping word however the model punctuated it', async () => {
    for (const [index, spelling] of ['no_reply', 'No Reply.', 'NO-REPLY!'].entries()) {
      const id = `c-stop-${index}`;
      const sessionId = await seed(id);
      globalThis.fetch = (async () => stream([delta(spelling), 'data: [DONE]\n'])) as never;
      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      expect((await settled(id)).stage, spelling).toBe('no-reply');
    }
  });
});
