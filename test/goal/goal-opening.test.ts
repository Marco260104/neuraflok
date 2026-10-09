import {
  decision,
  defaultConfig,
  goal,
  prompts,
  referenceTranscript,
  saveConfig,
} from './context.js';
import { describe, expect, it } from 'vitest';

/** The opening message of a chat ChatGPT has not named yet. No conversation id exists to key a draft to, because sending this very message is what makes ChatGPT issue one. It therefore runs outside the draft map entirely — and still has to go through the same protocol guard, the same caps and the same typing pass as every other message this app puts into somebody's chat. */
describe('opening a chat on a goal', () => {
  it('preserves Retry-After without retrying ambiguous browser sends', async () => {
    globalThis.fetch = (async () => new Response('busy', { status: 429, headers: { 'Retry-After': '37' } })) as never;
    const result = await goal.draftOpeningMessage('Implement the change');
    expect(result).toMatchObject({ retryable: true, retryAfterMs: 37000 });
    if (!('error' in result)) throw new Error('expected rate limit');
    expect(goal.nativeGoalFailure(result.error, 'api', result.retryAfterMs)).toMatchObject({ retryable: true, retryAfterMs: 37000 });
    expect(goal.nativeGoalFailure(result.error, 'web')).toMatchObject({ retryable: false });
    expect(goal.nativeGoalFailure('auth_rejected: bad key', 'api')).toMatchObject({ retryable: false });
  });

  it('writes the first message from the goal alone', async () => {
    let seen: { role: string; content: string }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = (JSON.parse(String(init.body)) as { messages: typeof seen }).messages;
      return decision('continue', 'rewrite the parser in rust — start with the lexer');
    }) as never;

    const drafted = await goal.draftOpeningMessage('  rewrite the parser in rust  ');

    expect(drafted).toEqual({
      reply: 'rewrite the parser in rust — start with the lexer',
      model: 'deepseek/deepseek-v4-flash'
    });
    expect(seen[0]!.content).toBe(prompts.DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT);
    expect(seen[1]!.content).toContain('rewrite the parser in rust');
    // Trimmed on the way in, so stray whitespace is not part of the goal it prompts against.
    expect(seen[1]!.content).not.toContain('  rewrite');
    expect(referenceTranscript(seen)).toEqual([
      { role: 'user', content: prompts.GOAL_OBJECTIVE_OPENING_TURN }
    ]);
    // The opening message runs outside the draft map but through the same assembly, closing reminder included — that sameness is the point of sharing one request builder.
    expect(seen.at(-1)!.content).toBe(prompts.GOAL_OBJECTIVE_TRAILER);
  });

  /** Stopping before a word has been said is the model refusing the goal, not meeting it. An empty opening message would leave somebody looking at a chat that never started. */
  it('refuses to open with nothing', async () => {
    globalThis.fetch = (async () => decision('stop')) as never;
    expect(await goal.draftOpeningMessage('finish it')).toEqual({ error: 'nothing_to_open_with' });
    expect(await goal.draftOpeningMessage('   ')).toEqual({ error: 'no_objective' });
  });

  /** The mode the sheet chose, for the one message that has no chat to read a switch from. A New Chat has no conversation and therefore no per-chat switch, so this used to draft under the app-wide setting — which is how a run started from "add specific loop" could be opened, and then continued, as a Goal that was free to decide it was finished. */
  it('opens under the mode it was given rather than the standing switch', async () => {
    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', model: 'deepseek/deepseek-v4-flash', enabled: false, mode: 'goal' }
    });
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return decision('continue', 'start with the chunk mesher');
    }) as never;

    await goal.draftOpeningMessage('build the voxel sandbox', 'loop');

    const messages = sent['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe(prompts.DEFAULT_GOAL_LOOP_SYSTEM_PROMPT);
    // The schema goes with the instruction: in loop mode the enum has no way to spell a stop, so the mode is enforced at the wire as well as asked for in words.
    expect(JSON.stringify(sent['response_format'])).toContain('always continue');
    // And the closing reminder is the loop's, which is where a model that only read the last thing it was shown is told that stopping is not one of its moves.
    expect(messages.at(-1)!.content).toBe(prompts.GOAL_LOOP_TRAILER);
  });
});
