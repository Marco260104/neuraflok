import {
  appendEvent,
  createSession,
  decision,
  defaultConfig,
  goal,
  prompts,
  recordLoopMcpProof,
  saveConfig,
  settled,
} from './context.js';
import { describe, expect, it } from 'vitest';

/** Loop mode: Goal with the stop taken away. Everything else about it is deliberately the same request — same key, same model, same context, same reply hygiene — so what is worth pinning here is only the difference, and the difference is a promise: with Loop on, a finished turn always gets a message back. Three things have to hold for that promise to be real, and all three are tested below. · The model is not offered a way to stop, in the instruction *and* in the schema. · A stop that arrives anyway is asked again rather than accepted. · A model that will not write is a failure the page can retry, never a sentence this app wrote and attributed to it. */
describe('the loop that never stops', () => {
  const loopMode = async (): Promise<void> => {
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal, backend: 'api', loopBackend: 'api',
        enabled: true,
        mode: 'loop',
        model: 'deepseek/deepseek-v4-flash'
      }
    });
  };

  const seed = async (conversationId: string): Promise<string> => {
    const session = await createSession({ title: 'loop', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'build the parser', truncated: false, chars: 16 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'all done, everything works', truncated: false, chars: 26 }
    });
    return session.id;
  };

  it('sends the loop instruction, its own trailer, and a schema with no stop in it', async () => {
    await loopMode();
    const sessionId = await seed('c-loop-1');
    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return decision('continue', 'go over the whole thing again and tell me what changed');
    }) as never;

    await recordLoopMcpProof(sessionId, 'g-loop-1');
    goal.startGoalDraft({ sessionId, conversationId: 'c-loop-1', turnId: 'g-loop-1' });
    const view = await settled('c-loop-1');

    expect(view.stage).toBe('ready');
    const system = body.messages
      .filter((message: { role: string }) => message.role === 'system')
      .map((message: { content: string }) => message.content);
    expect(system[0]).toBe(goal.goalLoopPrompt());
    // Neither of the other two instructions comes along: one would tell the model it may stop while the other tells it it may not.
    expect(system.join('\n')).not.toContain('You have exactly two moves');
    expect(system[1]).toContain('Action is always "continue"');
    expect(body.messages.at(-1).content).toBe(prompts.GOAL_LOOP_TRAILER);
    // The app's half of the same promise, made where a model cannot argue with it.
    expect(body.response_format.json_schema.schema.properties.action.enum).toEqual(['continue']);
  });

  it('keeps a chat’s own goal in front of the loop', async () => {
    await loopMode();
    const sessionId = await seed('c-loop-goal');
    goal.setGoalObjective('c-loop-goal', 'port the module and keep the suite green');
    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return decision('continue', 'the suite is still red. fix it');
    }) as never;

    await recordLoopMcpProof(sessionId, 'g-loop-goal');
    goal.startGoalDraft({ sessionId, conversationId: 'c-loop-goal', turnId: 'g-loop-goal' });
    expect((await settled('c-loop-goal')).stage).toBe('ready');

    const system = body.messages
      .filter((message: { role: string }) => message.role === 'system')
      .map((message: { content: string }) => message.content);
    expect(system[0]).toBe(goal.goalLoopPrompt());
    expect(system[1]).toContain('port the module and keep the suite green');
    // Loop replaces the instruction, not the goal — so the driver's own prompt stays out.
    expect(system.join('\n')).not.toContain('stop, by answering exactly NO_REPLY');
  });

  /** The mode is a thing the user switched on, so it is never inherited. A chat that runs only because it carries its own goal, with the standing switch off, is still a Goal run — and Goal is the half of this pair that is allowed to decide the job is finished. */
  it('is not entered by a chat that only carries its own goal while the switch is off', async () => {
    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', enabled: false, mode: 'loop', model: 'deepseek/deepseek-v4-flash' }
    });
    const sessionId = await seed('c-loop-off');
    goal.setGoalObjective('c-loop-off', 'get the release out');
    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return decision('stop');
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-loop-off', turnId: 'g-loop-off' });
    const view = await settled('c-loop-off');

    // Stopping is available again, and it was asked exactly once.
    expect(view.stage).toBe('no-reply');
    expect(body.messages[0].content).toBe(goal.goalObjectivePrompt());
    expect(body.response_format.json_schema.schema.properties.action.enum).toEqual(['stop', 'continue']);
  });

  /** Structured output already removes the word, so a stop reaching the app means the model wrote the sentinel into the message text. That is a malformed answer, and the repair is to ask again with the refusal spelled out — never to invent the message ourselves. */
  it('asks again when the loop tries to stop, and uses the message it writes next', async () => {
    await loopMode();
    const sessionId = await seed('c-loop-retry');
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1 ? decision('continue', 'NO_REPLY') : decision('continue', 'keep going, the export is missing');
    }) as never;

    await recordLoopMcpProof(sessionId, 'g-loop-retry');
    goal.startGoalDraft({ sessionId, conversationId: 'c-loop-retry', turnId: 'g-loop-retry' });
    const view = await settled('c-loop-retry');

    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('keep going, the export is missing');
    expect(bodies).toHaveLength(2);
    // The second attempt is the first one plus the refusal, so the model is told exactly what was wrong with the answer it just gave.
    const second = bodies[1].messages
      .filter((message: { role: string }) => message.role === 'system')
      .map((message: { content: string }) => message.content);
    expect(second).toContain(prompts.GOAL_LOOP_STOP_REFUSED);
  });

  it('gives up retryably rather than typing a sentence the model never wrote', async () => {
    await loopMode();
    const sessionId = await seed('c-loop-refused');
    let asked = 0;
    globalThis.fetch = (async () => {
      asked += 1;
      return decision('continue', 'NO_REPLY');
    }) as never;

    await recordLoopMcpProof(sessionId, 'g-loop-refused');
    goal.startGoalDraft({ sessionId, conversationId: 'c-loop-refused', turnId: 'g-loop-refused' });
    const view = await settled('c-loop-refused');

    // Bounded: a chat that will not answer must not spend the key in a circle.
    expect(asked).toBe(3);
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('loop_stop_refused');
    expect(view.reply).toBe('');
    // The turn is still owed an answer, so the page may ask again on its own clock. This is the one thing that keeps the promise honest across a model having a bad minute.
    expect(view.retryable).toBe(true);
  });

  it('writes the opening message of a new chat under the loop instruction too', async () => {
    await loopMode();
    const seen: { role: string; content: string }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      seen.push(...body.messages);
      return decision('continue', 'start on the scraper, one row per product');
    }) as never;

    const drafted = await goal.draftOpeningMessage('scrape the prices into a csv');

    expect(drafted).toEqual({
      reply: 'start on the scraper, one row per product',
      model: 'deepseek/deepseek-v4-flash'
    });
    expect(seen[0]!.content).toBe(goal.goalLoopPrompt());
    expect(seen[1]!.content).toContain('scrape the prices into a csv');
  });
});
