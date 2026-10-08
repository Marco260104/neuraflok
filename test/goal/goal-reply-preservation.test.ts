import {
  appendEvent,
  createSession,
  delta,
  goal,
  settled,
  stream,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('Goal reply preservation', () => {
  it('delivers the provider reply without changing punctuation or spelling', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-reply-preserved' });
    const reply = 'the tests still fail — inspect the id-less sections.';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    globalThis.fetch = (async () => stream([delta(reply), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-reply-preserved', turnId: 'g-reply-preserved' });
    const view = await settled('c-reply-preserved');

    expect(view.stage).toBe('ready');
    expect(view.reply).toBe(reply);
  });
});
