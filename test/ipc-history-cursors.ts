import { describe, expect, it } from 'vitest';
import { handlers, appendEvent, createSession, upsertMessageEvent } from './ipc-context.js';
describe('session history IPC cursors', () => {
it('keeps origin history navigation separate from live revision cursors over IPC', async () => {
  const session = await createSession({ title: 'History cursors' });
  const message = { kind: 'assistant_message' as const, source: 'extension' as const, time: 10,
    messageId: 'review', message: { text: 'Detailed review', truncated: false, chars: 15 }, final: true };
  const first = await upsertMessageEvent(session.id, message);
  await appendEvent(session.id, { kind: 'note', source: 'app', time: 20, message: { text: 'Later work', truncated: false, chars: 10 } });
  const revision = await upsertMessageEvent(session.id, { ...message, message: { text: 'Detailed review revised', truncated: false, chars: 23 } });
  const read = (options: object) => handlers.get('sessions:events')!(null, { id: session.id, ...options }) as Promise<any>;
  const tail = await read({ limit: 1 });
  expect(tail.ok).toBe(true);
  expect(tail.data.events[0].kind).toBe('note');
  const older = await read({ before: tail.data.events[0].seq, limit: 1 });
  expect(older.data.events[0]).toMatchObject({ kind: 'assistant_message', origin: first.event.seq, seq: revision.event.seq });
  const newer = await read({ after: first.event.seq, limit: 1 });
  expect(newer.data.events[0].kind).toBe('note');
  const delta = await read({ from: revision.event.seq, limit: 1 });
  expect(delta.data.events[0].messageId).toBe('review');
  expect(delta.data.nextFrom).toBe(revision.event.seq + 1);
});

});
