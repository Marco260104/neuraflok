import {
  DEFAULT_HANDOFF_PROMPT,
  createSession,
  flushSessions,
  getSession,
  recordWorkerAssignment,
  resetSessionStoreForTests,
} from './context.js';
import { expect, it } from 'vitest';

it('ships the NEURAFLOK continuation format as the editable default', () => {
  // Keep the default brief explicit so users can rely on the same sections without opening Settings.
  expect(DEFAULT_HANDOFF_PROMPT).toContain('target roughly 10,000–30,000 tokens');
  for (const heading of ['TASK —', 'USER DECISIONS —', 'CURRENT STATE —', 'DONE AND VERIFIED —', 'IN PROGRESS —', 'NEXT STEPS —',
    'OPEN ISSUES —', 'FILES AND CHANGES —', 'CHECKS AND EVIDENCE —', 'RUNTIME CONTEXT —', 'DO NOT REPEAT —']) {
    expect(DEFAULT_HANDOFF_PROMPT, heading).toContain(heading);
  }
});

it('persists worker presentation independently of broker retention and rejects stale or foreign projections', async () => {
  const session = await createSession({ conversationId: 'archive-worker', title: 'Original',
    origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Original task' } });
  const assignment = { conversationId: 'archive-worker', agentId: 'worker-1', label: 'Review', task: 'New task', recordedAt: 20 };
  await recordWorkerAssignment(assignment);
  await recordWorkerAssignment({ ...assignment, label: 'Stale', recordedAt: 10 });
  await recordWorkerAssignment({ ...assignment, agentId: 'worker-2', label: 'Foreign', recordedAt: 30 });
  await flushSessions(); resetSessionStoreForTests();
  const restored = await getSession(session.id);
  expect(restored?.workerAssignment).toEqual(assignment);
  expect(restored?.origin?.task).toBe('Original task');
  expect(restored?.title).toBe('Original');
});
