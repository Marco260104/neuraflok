import {
  appendEvent,
  createSession,
  decision,
  defaultConfig,
  delta,
  goal,
  prompts,
  recordLoopMcpProof,
  referenceTranscript,
  saveConfig,
  settled,
  stream,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('what leaves this machine', () => {
  it('preserves transient API retry classification and Retry-After for finish follow-ups', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, loopBackend: 'api' } });
    const session = await createSession({ title: 'finish retry', conversationId: 'finish-api-retry' });
    await recordLoopMcpProof(session.id);
    const context = [{ role: 'user' as const, content: 'Finish checking the project' }];
    globalThis.fetch = vi.fn(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '37' } }));
    await expect(goal.draftFastFollowup(session.id, undefined, context)).rejects.toMatchObject({ retryable: true, retryAfterMs: 37000 });
    globalThis.fetch = vi.fn(async () => new Response('bad key', { status: 401 }));
    await expect(goal.draftFastFollowup(session.id, undefined, context)).rejects.toMatchObject({ retryable: false });
    globalThis.fetch = vi.fn(async () => { throw new TypeError('network disconnected'); });
    await expect(goal.draftFastFollowup(session.id, undefined, context)).rejects.toMatchObject({ retryable: true });
    const timeout = AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    await expect(goal.draftFastFollowup(session.id, timeout, context)).rejects.toMatchObject({ retryable: true });
  });
  it.each([false, true])('excludes tool bodies from decisions and finish even with legacy tool opt-in (%s)', async (includeToolCalls) => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'api', loopBackend: 'api', includeToolCalls } });
    const session = await createSession({ title: 'tool context', conversationId: `tool-context-${includeToolCalls}` });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'user_message', message: { text: 'Check the project', chars: 17, truncated: false } });
    await appendEvent(session.id, { time: 110, source: 'extension', kind: 'assistant_message', messageId: 'interim-one', final: false,
      message: { text: 'Inspecting the project', chars: 22, truncated: false } });
    await appendEvent(session.id, { time: 120, source: 'mcp', kind: 'tool_call', call: {
      callId: 'context-call', tool: 'read', attribution: 'request_id', requestId: 'context-request', conversationId: session.conversationId, attributionMethod: 'request_id', outcome: 'ok', durationMs: 1,
      args: { text: '{"path":"/project/example"}', chars: 27, truncated: false },
      result: { text: 'tool-result-evidence', chars: 20, truncated: false },
      summary: { kind: 'read', tone: 'neutral', title: 'Read example' }
    } });
    const projected = await goal.conversationMessages(session.id);
    expect(projected.some(message => message.content.includes('Inspecting the project'))).toBe(true);
    expect(projected.some(message => message.content.includes('tool-result-evidence'))).toBe(false);
    expect(projected.some(message => message.content.includes('/project/example'))).toBe(false);
    let sent = '';
    globalThis.fetch = vi.fn(async (_url, init) => { sent = String(init?.body); return decision('continue', 'Continue checking the project.'); });
    await recordLoopMcpProof(session.id);
    await goal.draftFastFollowup(session.id);
    expect(sent.includes('Inspecting the project')).toBe(true);
    expect(sent.includes('tool-result-evidence')).toBe(false);
    expect(sent.includes('/project/example')).toBe(false);
  });

  it('tells the helper how many NEURAFLOK calls a turn made, and nothing about them', async () => {
    // Live 2026-09-28: the helper saw only "goal-ok" and asked five more times to "actually run" a command that had run every time.
    const session = await createSession({ title: 'tool count', conversationId: 'tool-count' });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'user_message', message: { text: 'Run echo goal-ok', chars: 16, truncated: false } });
    for (const [index, [turnId, tool]] of ([['count-turn', 'exec_command'], ['count-turn', 'exec_command'], ['count-turn', 'session_finish'], ['other-turn', 'exec_command']] as const).entries()) {
      await appendEvent(session.id, { time: 110 + index, source: 'mcp', kind: 'tool_call', turnId, call: {
        callId: `count-call-${index}`, tool, attribution: 'request_id', requestId: `count-request-${index}`, conversationId: session.conversationId,
        attributionMethod: 'request_id', outcome: 'ok', durationMs: 1,
        args: { text: '{"cmd":"echo SECRET_ARGUMENT"}', chars: 30, truncated: false },
        result: { text: 'SECRET_RESULT', chars: 13, truncated: false },
        summary: { kind: 'run', tone: 'neutral', title: 'Ran a command' }
      } });
    }
    await appendEvent(session.id, { time: 120, source: 'extension', kind: 'assistant_message', turnId: 'count-turn', messageId: 'count-final', final: true,
      message: { text: 'goal-ok', chars: 7, truncated: false } });
    const projected = await goal.conversationMessages(session.id);
    expect(projected).toEqual([
      { role: 'user', content: 'Run echo goal-ok' },
      { role: 'assistant', content: 'goal-ok\n\n[NEURAFLOK: 2 tool calls ran in this turn. Arguments and results are not shown.]' }
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/exec_command|SECRET_ARGUMENT|SECRET_RESULT/);
  });

  it('removes unsupported reply markers from helper context', async () => {
    const session = await createSession({ title: 'pointer replies', conversationId: 'pointer-replies' });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'user_message', message: { text: 'Hi', chars: 2, truncated: false } });
    const pointer = '::provider-reference{index="0" source_message_id="message-1"}';
    await appendEvent(session.id, { time: 110, source: 'extension', kind: 'assistant_message', messageId: 'pointer-final', final: true,
      message: { text: pointer, chars: pointer.length, truncated: false } });
    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '[This reply contains an unrecorded content reference.]' }
    ]);
  });

  it('gives decision helpers authored requests without executor guidance in the reference transcript', async () => {
    const { prependUserPrompt } = await import('../../contracts/messaging/provider-message-envelope.js');
    const session = await createSession({ title: 'authored helper context', conversationId: 'authored-helper-context' });
    const framed = prependUserPrompt('Full workflow carrier', 'EXECUTOR_GUIDANCE_ONLY');
    await appendEvent(session.id, { time: 100, source: 'app', kind: 'user_message', messageId: 'authored-helper-user',
      authoredText: 'Original user requirements', message: { text: framed.replace(/\n\n/g, '\n'), chars: framed.length, truncated: false } });
    const next = prependUserPrompt('Next checkpoint', 'EXECUTOR_GUIDANCE_ONLY');
    expect(await goal.conversationMessages(session.id, [next])).toEqual([
      { role: 'user', content: 'Original user requirements' }, { role: 'user', content: 'Next checkpoint' }
    ]);
  });

  /** The privacy boundary. The goal model decides whether the user's request has been met, and the conversation is the only evidence it needs for that — every tool call, argument, result and file path is this machine's business and stays here. */
  it('is the conversation and nothing else', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-1' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'add the retry', truncated: false, chars: 13 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-1',
        tool: 'read',
        attribution: 'request_id',
        requestId: 'wfr_1',
        conversationId: 'c-goal-1',
        attributionMethod: 'request_id',
        args: { text: '{"path":"/repo/secrets.env"}', truncated: false, chars: 28 },
        result: { text: 'SECRET=hunter2', truncated: false, chars: 14 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'read', tone: 'neutral', title: 'Read secrets.env' }
      }
    });
    await appendEvent(session.id, {
      time: 1_200,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'done, added it', truncated: false, chars: 14 }
    });
    // A streaming snapshot of the same answer. Including it would show the model the same reply twice, with the half-written one second.
    await appendEvent(session.id, {
      time: 1_150,
      source: 'extension',
      kind: 'assistant_message',
      final: false,
      message: { text: 'done, add', truncated: false, chars: 9 }
    });

    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'add the retry' },
      { role: 'assistant', content: 'done, added it' }
    ]);
  });

  it('includes interim commentary once at its original position and excludes app notices', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-interim' });
    await appendEvent(session.id, { time: 1000, source: 'extension', kind: 'user_message',
      message: { text: 'Fix and test', chars: 12, truncated: false } });
    await appendEvent(session.id, { time: 1100, source: 'extension', kind: 'progress', progressId: 'commentary',
      message: { text: 'Testing', chars: 7, truncated: false } });
    await appendEvent(session.id, { time: 1200, source: 'extension', kind: 'assistant_message', final: true,
      message: { text: 'Done', chars: 4, truncated: false } });
    await appendEvent(session.id, { time: 1300, source: 'extension', kind: 'progress', progressId: 'commentary',
      message: { text: 'Testing completed', chars: 17, truncated: false } });
    await appendEvent(session.id, { time: 1400, source: 'app', kind: 'progress', progressId: 'notice',
      message: { text: 'Checking Goal', chars: 13, truncated: false } });
    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'Fix and test' },
      { role: 'assistant', content: 'Testing completed' },
      { role: 'assistant', content: 'Done' }
    ]);
  });

  it('collapses repeated final snapshots from a legacy append-only recording by ChatGPT message id', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-legacy-snapshots' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'user-1',
      message: { text: 'fix the parser', truncated: false, chars: 14 }
    });
    // Pre-canonical-store recordings could append the same stable ChatGPT message more than once. Both rows can be final (for example after a remount/replay), and Goal must see the latest snapshot as one answer rather than two assistant turns.
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      final: true,
      message: { text: 'parser fixed, tests still running', truncated: false, chars: 32 }
    });
    await appendEvent(session.id, {
      time: 1_200,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      final: true,
      message: { text: 'parser fixed, tests are green', truncated: false, chars: 29 }
    });

    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: 'parser fixed, tests are green' }
    ]);
  });

  it('sends the whole conversation with the instruction in front of it', async () => {
    const customPrompt = 'CUSTOM GOAL PROMPT: stop with NO_REPLY; otherwise name the missing requested item.';
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal, backend: 'api', loopBackend: 'api',
        enabled: true,
        model: 'deepseek/deepseek-v4-flash',
        prompt: customPrompt
      }
    });
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-2' });
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
      message: { text: 'parser written, tests pending', truncated: false, chars: 28 }
    });

    let sent: any = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return decision('continue', 'what about the tests');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-2', turnId: 'g-1' });
    const view = await settled('c-goal-2');

    expect(view.stage).toBe('ready');
    expect(view.reply).toBe('what about the tests');
    expect(sent.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((sent.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(sent.body.model).toBe('deepseek/deepseek-v4-flash');
    expect(sent.body.messages[0].role).toBe('system');
    expect(sent.body.messages[0].content).toBe(customPrompt);
    expect(sent.body.messages[1]).toMatchObject({ role: 'system' });
    expect(sent.body.messages[1].content).toContain('response schema');
    expect(referenceTranscript(sent.body.messages)).toEqual([
      { role: 'user', content: 'build the parser' },
      { role: 'assistant', content: 'parser written, tests pending' }
    ]);
    // The closing reminder sits after the transcript, not with the instruction: a long chat pushes everything above it out of the model's effective attention, and what it read last is what it obeys. Placement is app-owned; the policy it restates is not.
    const trailer = sent.body.messages.at(-1);
    expect(trailer.role).toBe('system');
    expect(trailer.content).toBe(prompts.GOAL_SYSTEM_TRAILER);
    expect(sent.body.stream).toBe(true);
    expect(sent.body.reasoning).toEqual({ exclude: true });
    expect(sent.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'goal_decision', strict: true }
    });
    expect(sent.body.response_format.json_schema.schema.properties.action.description).toContain(
      'continue while concrete requested work or questions are not yet clearly completed or answered'
    );
    expect(sent.body.plugins).toBeUndefined();
    expect(sent.body.provider).toEqual({ require_parameters: true });
  });

  it('does not ask OpenRouter to invent a continuation when no user goal was recorded', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-no-user' });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'an answer survived but its user prompt did not', truncated: false, chars: 42 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('invent more work'), 'data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-no-user', turnId: 'g-no-user' });
    const view = await settled('c-goal-no-user');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
    expect(calls).toBe(0);
  });

  it('keeps the conclusion of an over-long message instead of clipping away the newest result', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-long' });
    const conclusion = 'FINAL RESULT: the regression is fixed and every focused test is green';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'fix the race and verify it', truncated: false, chars: 26 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: {
        text: `analysis starts here\n${'x'.repeat(14_000)}\n${conclusion}`,
        truncated: false,
        chars: 14_100
      }
    });

    const messages = await goal.conversationMessages(session.id);
    const answer = messages.at(-1)?.content ?? '';
    expect(answer).toContain('analysis starts here');
    // The goal model decides whether work is finished. Long ChatGPT answers commonly put that verdict at the end, so a per-message budget that keeps only the prefix removes the exact evidence this loop exists to inspect.
    expect(answer).toContain(conclusion);
    expect(answer).toContain('cut');
    expect(answer.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps the original user goal when recent history alone exceeds the total context budget', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-anchor' });
    const original = 'ORIGINAL GOAL: fix the durability race, prove it with a crash regression, then stop';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: original, truncated: false, chars: original.length }
    });

    // Twelve clipped-size answers plus their follow-ups push the recent tail well past 120k. The old newest-first trimmer therefore discarded the first user message even though the Goal prompt tells the model to decide whether precisely that original request is done.
    for (let index = 0; index < 12; index++) {
      const answer = `work chunk ${index}\n${String(index).repeat(12_500)}`;
      await appendEvent(session.id, {
        time: 2_000 + index * 2,
        source: 'extension',
        kind: 'assistant_message',
        final: true,
        message: { text: answer, truncated: false, chars: answer.length }
      });
      await appendEvent(session.id, {
        time: 2_001 + index * 2,
        source: 'extension',
        kind: 'user_message',
        message: { text: `continue with chunk ${index}`, truncated: false, chars: 22 }
      });
    }

    const messages = await goal.conversationMessages(session.id);
    expect(messages[0]).toEqual({ role: 'user', content: original });
    expect(messages.at(-1)?.content).toBe('continue with chunk 11');
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(120_000);
  });

  it('keeps the actual first user goal when the recent-reader row window itself is saturated', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-anchor-beyond-tail' });
    const original = 'ORIGINAL GOAL OUTSIDE THE RECENT WINDOW: finish the migration and stop';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: original, truncated: false, chars: original.length }
    });

    // conversationMessages asks readRecentEvents for 240 logical rows. More than that used to make its "first user" anchor merely the oldest follow-up left in the tail, while the system prompt still told the model it had been given what the user originally asked for.
    for (let index = 0; index < 130; index++) {
      const answer = `assistant result ${index}`;
      const followup = `follow-up ${index}`;
      await appendEvent(session.id, {
        time: 2_000 + index * 2,
        source: 'extension',
        kind: 'assistant_message',
        final: true,
        message: { text: answer, truncated: false, chars: answer.length }
      });
      await appendEvent(session.id, {
        time: 2_001 + index * 2,
        source: 'extension',
        kind: 'user_message',
        message: { text: followup, truncated: false, chars: followup.length }
      });
    }

    const messages = await goal.conversationMessages(session.id);
    expect(messages[0]).toEqual({ role: 'user', content: original });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'follow-up 129' });
    expect(messages.length).toBeLessThanOrEqual(120);
  });

  it('preserves a large brief and middle steering after hundreds of assistant updates', async () => {
    const session = await createSession({ title: 'large task', conversationId: 'large-context' });
    const original = 'START OF BRIEF\n' + 'whole product requirements '.repeat(400) + '\nMIDDLE REQUIREMENT: complete the whole world\n' + 'integration and gameplay '.repeat(400) + '\nEND OF BRIEF';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: original, chars: original.length, truncated: false } });
    const correction = 'CORRECTION: keep the original full plan and improve exploration, combat and progression together';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1001,
      message: { text: correction, chars: correction.length, truncated: false } });
    for (let index = 0; index < 260; index++) {
      const text = `interim ${index}: ` + 'current implementation detail '.repeat(200);
      await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', messageId: `large-interim-${index}`, final: false, time: 2000 + index,
        message: { text, chars: text.length, truncated: false } });
    }
    const messages = await goal.conversationMessages(session.id);
    expect(messages).toContainEqual({ role: 'user', content: original });
    expect(messages).toContainEqual({ role: 'user', content: correction });
    expect(messages.at(-1)?.content).toContain('interim 259');
    expect(messages.length).toBeLessThanOrEqual(120);
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(120_000);
  });

  it('marks an oversized brief as clipped while retaining both ends', async () => {
    const session = await createSession({ title: 'oversized task', conversationId: 'oversized-context' });
    const original = 'FIRST REQUIREMENT\n' + 'x'.repeat(96_000) + '\nLAST REQUIREMENT';
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: original, chars: original.length, truncated: false } });
    const [message] = await goal.conversationMessages(session.id);
    expect(message?.content).toContain('FIRST REQUIREMENT');
    expect(message?.content).toContain('LAST REQUIREMENT');
    expect(message?.content).toContain('[… cut …]');
    expect(message?.content.length).toBeLessThanOrEqual(48_000);
  });

  it('retains the newest result when large delivered inputs follow the recorded history', async () => {
    const session = await createSession({ title: 'injected context', conversationId: 'injected-context' });
    const original = 'ORIGINAL BRIEF ' + 'x'.repeat(47_000);
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: 1000,
      message: { text: original, chars: original.length, truncated: false } });
    await appendEvent(session.id, { source: 'extension', kind: 'assistant_message', final: true, time: 1001,
      message: { text: 'The current implementation is integrated; gameplay validation remains.', chars: 68, truncated: false } });
    const messages = await goal.conversationMessages(session.id,
      Array.from({ length: 5 }, (_, index) => `User correction ${index}: ` + 'y'.repeat(47_000)));
    expect(messages).toContainEqual({ role: 'user', content: original });
    expect(messages.some(message => message.role === 'assistant' && message.content.includes('gameplay validation remains'))).toBe(true);
    expect(messages.at(-1)?.content).toContain('User correction 4');
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(120_000);
  });

  it('asks for a reasoning effort only when one was chosen', async () => {
    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'high' }
    });
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-3' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go', truncated: false, chars: 2 }
    });

    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return decision('continue', 'next bit please');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-3', turnId: 'g-1' });
    await settled('c-goal-3');
    expect(body.reasoning).toEqual({ effort: 'high', exclude: true });
  });
});
