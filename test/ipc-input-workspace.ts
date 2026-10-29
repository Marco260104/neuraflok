import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  handlers,
  defaultConfig,
  getConfig,
  saveConfig,
  appendEvent,
  createSession,
  readDurable,
  writeDurableNow,
  bindConversation,
  restoreSwarm,
  spawn,
  dialog,
  save,
  sessionList,
  settings,
  ipcFixture,
} from './ipc-context.js';
describe('input and workspace IPC behavior', () => {
it('validates dropped file count and stages arbitrary native file types', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: Array(21).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ files: [''] })).toMatchObject({ ok: false });
  expect(await drop({ files: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: true, data: [expect.objectContaining({ name: 'package.json', mimeType: 'application/json' })] });
});

it('publishes Goal draft progress through the session refresh channel without a new transcript event', async () => {
  const { startGoalDraft, resetGoalStateForTests } = await import('../backend/domains/automation/goal.js');
  const session = await createSession({ title: 'Goal progress', conversationId: 'ipc-goal-progress' });
  ipcFixture.currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  try {
    startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'finished-turn', deferStart: true });
    expect(ipcFixture.currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
  } finally {
    resetGoalStateForTests();
  }
});

it('publishes the exact transcript owners of one recorder burst and an explicit global invalidation', async () => {
  const { recordNote, resetRecorderForTests } = await import('../backend/domains/sessions/history/recorder.js');
  resetRecorderForTests();
  const first = await createSession({ title: 'Changed A', conversationId: 'ipc-changed-a' });
  const second = await createSession({ title: 'Changed B', conversationId: 'ipc-changed-b' });
  const send = vi.fn();
  ipcFixture.currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send } };
  await recordNote(first.id, 'first owner');
  await recordNote(second.id, 'second owner');
  await recordNote(first.id, 'first owner again');
  await vi.waitFor(() => expect(send.mock.calls.filter(([channel]) => channel === 'session:changed')).toHaveLength(1));
  const [, change] = send.mock.calls.find(([channel]) => channel === 'session:changed')!;
  expect(change.sessionIds).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(new Set(change.sessionIds).size).toBe(change.sessionIds.length);
  send.mockClear();
  expect(await handlers.get('sessions:clearImageStorage')!(null, { mode: 'all' })).toMatchObject({ ok: true });
  expect(send).toHaveBeenCalledWith('session:changed', { allTranscripts: true });
});

it('publishes the owning session when delivered input history is revised in place', async () => {
  const input = await import('../backend/domains/sessions/input/input.js');
  const store = await import('../backend/domains/sessions/history/store.js');
  const previous = await readDurable('session-input');
  const session = await createSession({ title: 'Input revision owner', conversationId: 'input-revision-owner' });
  const id = '30000000-0000-4000-8000-000000000002';
  const send = vi.fn();
  ipcFixture.currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send } };
  const owners = () => send.mock.calls.filter(([channel, change]) => channel === 'session:changed' && change?.sessionIds?.includes(session.id));
  const row = { id, sessionId: session.id, text: 'Revised fixture', mode: 'auto', model: null, reasoningEffort: null, dueAt: 100,
    createdAt: 100, owner: 'request', conversationId: 'input-revision-owner', offeredAt: 200, historyRecorded: false };
  try {
    await writeDurableNow('session-input', [{ ...row, state: 'tool' }]);
    input.resetInputForTests();
    expect(await handlers.get('sessions:outbox')!(null, undefined)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(owners()).toHaveLength(1));
    send.mockClear();
    // Same canonical key, same anchor and count: only the delivery state changes in place.
    await writeDurableNow('session-input', [{ ...row, state: 'sent', owner: null, messageId: `input:${id}`, deliveredAt: 300 }]);
    input.resetInputForTests();
    expect(await handlers.get('sessions:outbox')!(null, undefined)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(owners()).toHaveLength(1));
    const users = (await store.readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ inputId: id, inputDelivery: 'confirmed' });
  } finally {
    await writeDurableNow('session-input', previous ?? []);
    input.resetInputForTests();
  }
});

it('stages clipboard image bytes with a preview through the general attachment owner', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: [{ name: 'huge.png', bytes: new Uint8Array(100 * 1024 * 1024 + 1) }] })).toMatchObject({ ok: false });
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const pasted = await drop({ files: [{ name: 'screenshot.png', bytes: new Uint8Array(bytes) }] });
  expect(pasted).toMatchObject({ ok: true, data: [{ name: 'screenshot.png', size: bytes.length, mimeType: 'image/png', preview: expect.stringMatching(/^data:image\/webp;base64,/) }] });
  const { readInputAttachmentChunk } = await import('../backend/domains/sessions/input/attachments/index.js');
  expect(await readInputAttachmentChunk(pasted.data[0], 0)).toBe(bytes.toString('base64'));
});

it('does not authorize the composer Generate Goal action from an absent or stale finish wait', async () => {
  const generate = (payload: unknown) => handlers.get('sessions:generateFinishGoal')!(null, payload) as Promise<any>;
  const session = await createSession({ title: 'No finish wait', conversationId: 'finish-action-ipc-chat' });
  expect(await generate({ id: session.id })).toMatchObject({ ok: false });
  expect(await generate({ id: session.id, expectedTurnId: 'old-turn' })).toMatchObject({ ok: false });
});

it('round-trips Goal controls and cannot revive old periodic input when Off cancellation fails then On retries', async () => {
  const outbox = await import('../backend/domains/sessions/input/input.js');
  const durable = await import('../backend/persistence/durable.js');
  const store = await import('../backend/domains/sessions/history/store.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const config = (minutes: number) => ({ ...settings({ record: true, multiAgent: false }),
    ui: { ...defaultConfig().ui, finishTool: true },
    goal: { ...defaultConfig().goal, impulseMinutes: minutes, includeToolCalls: true } });
  let write: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await save(config(1))).toMatchObject({ ok: true });
    expect(getConfig().goal).toMatchObject({ impulseMinutes: 1, includeToolCalls: true });
    const session = await createSession({ title: 'Periodic ownership', conversationId: 'periodic-settings-chat' });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'periodic-turn', time: Date.now() });
    await store.observeSessionModel(session.id, 'periodic-settings-chat', 'gpt-6-astra', Date.now());
    const row = await outbox.enqueueInput({ id: 'f0f00014-1111-4111-8111-111111111111', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, mode: 'goal', userRequested: true });
    // Seed an old-version row; current code deliberately refuses new periodic input.
    await writeDurableNow('session-input', [{ ...row, finishOwner: { turnId: 'periodic-turn', periodic: true } }]);
    outbox.resetInputForTests();
    write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('Cancellation disk failure'));
    expect(await save(config(0))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Off was published before retirement.
    write.mockRejectedValueOnce(new Error('Still cannot retire'));
    expect(await save(config(1))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Failed retirement cannot publish On.
    write.mockRestore(); write = undefined;
    expect(await save(config(1))).toMatchObject({ ok: true });
    outbox.resetInputForTests();
    expect((await outbox.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual({ messages: [], reminder: '' });
  } finally {
    write?.mockRestore();
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('native opening cancellation aborts the exact IPC invocation and prevents a late ready result', async () => {
  const goal = await import('../backend/domains/automation/goal.js');
  const requestId = 'ad3ecbf4-c3a1-4d0d-9e9f-619787bcf982';
  let signal: AbortSignal | undefined;
  const draft = vi.spyOn(goal, 'draftOpeningMessage').mockImplementation(async (_text, _mode, _progress, current) => {
    signal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  });
  try {
    const opening = handlers.get('sessions:goalOpening')!(null, { text: 'Implement safely', mode: 'goal', requestId });
    const cancelled = await handlers.get('tasks:cancel')!(null, { requestId }) as any;
    expect(cancelled).toEqual({ ok: true, data: true });
    expect(signal?.aborted).toBe(true);
    expect(await opening).toMatchObject({ ok: false, error: 'task_cancelled' });
    expect(draft).toHaveBeenCalledTimes(1);
  } finally { draft.mockRestore(); }
});

it('projects exact retained worker parents without adopting same-name unrelated recordings', async () => {
  const prime = await createSession({ title: 'Parent', conversationId: 'parent-projection' });
  spawn({ workers: [{ task: 'test parent identity' }], caller: { conversationId: 'parent-projection' } });
  expect(bindConversation('worker-1', 'worker-projection')).toBe(true);
  const origin = { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'test parent identity' };
  const child = await createSession({ title: 'Child', conversationId: 'worker-projection', origin });
  const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-worker', origin });
  const result = await sessionList();
  expect(result.ok).toBe(true);
  expect(result.data.sessions.find((row: any) => row.id === child.id).origin.fromSessionId).toBe(prime.id);
  expect(result.data.sessions.find((row: any) => row.id === unrelated.id).origin.fromSessionId).toBeNull();
  restoreSwarm(null); // End this fixture without user-clear retiring it into later tests.
});

it('adds picker-selected projects, reuses containing approval, and leaves cancellation unchanged', async () => {
  ipcFixture.currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const folder = path.join(ipcFixture.dir, 'picker-project');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await writeDurableNow('projects', []);
  const add = () => handlers.get('projects:add')!(null, {}) as Promise<any>;
  expect((await add()).data).toBeNull();
  expect(getConfig().roots).toHaveLength(0);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [folder] });
  const first = await add();
  expect(first.ok, first.error).toBe(true);
  expect(first.data.name).toBe('picker-project');
  expect(getConfig().roots).toHaveLength(1);
  expect((await add()).data.id).toBe(first.data.id);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path.join(folder, 'child')] });
  expect((await add()).data.name).toBe('child');
  expect(getConfig().roots).toHaveLength(1);
  const listed = await handlers.get('projects:list')!(null, {}) as any;
  expect(listed.data).toHaveLength(2);
  const colored = await handlers.get('projects:color')!(null, { id: first.data.id, color: 'blue' }) as any;
  expect(colored).toMatchObject({ ok: true, data: { id: first.data.id, color: 'blue' } });
  expect(await handlers.get('projects:color')!(null, { id: first.data.id, color: 'chartreuse' })).toMatchObject({ ok: false });
  const uncolored = await handlers.get('projects:color')!(null, { id: first.data.id, color: null }) as any;
  expect(uncolored).toMatchObject({ ok: true, data: { id: first.data.id } });
  expect(uncolored.data.color).toBeUndefined();
  const removed = await handlers.get('projects:remove')!(null, { id: first.data.id }) as any;
  expect(removed).toMatchObject({ ok: true, data: { id: first.data.id, ungrouped: true } });
  expect(getConfig().roots).toHaveLength(1);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await handlers.get('projects:remove')!(null, { id: folder })).toMatchObject({ ok: false });
  expect(await handlers.get('projectGit:snapshot')!(null, { projectId: folder })).toMatchObject({ ok: false });
  expect(await handlers.get('projectGit:diff')!(null, { projectId: first.data.id, path: '' })).toMatchObject({ ok: false });
  expect(await handlers.get('sessions:toolEditReview')!(null, {
    sessionId: first.data.id, callId: 'not-a-uuid', changeIndex: 0
  })).toMatchObject({ ok: false });
});

it('does not install a stale Git watch after a newer Files project watch', async () => {
  const { ProjectFileWatchSet } = await import('../backend/domains/workspace/project-file-watcher.js');
  const { ProjectGitWatchSet } = await import('../backend/domains/workspace/git/index.js');
  const contents = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false });
  ipcFixture.currentWindow = { isDestroyed: () => false, webContents: contents } as any;
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  let finishFirst!: () => void, finishSecond!: () => void;
  const fileSync = vi.spyOn(ProjectFileWatchSet.prototype, 'sync').mockImplementation(projectId =>
    new Promise<void>(resolve => { if (projectId === firstId) finishFirst = resolve; else finishSecond = resolve; }));
  const gitSync = vi.spyOn(ProjectGitWatchSet.prototype, 'sync').mockResolvedValue();
  try {
    const watch = (projectId: string) => handlers.get('projectFiles:watch')!(null, { projectId, directories: [''] });
    const first = watch(firstId);
    const second = watch(secondId);
    finishSecond();
    expect(await second).toMatchObject({ ok: true, data: true });
    finishFirst();
    expect(await first).toMatchObject({ ok: true, data: false });
    expect(gitSync).toHaveBeenCalledOnce();
    expect(gitSync).toHaveBeenCalledWith(secondId);
  } finally {
    fileSync.mockRestore();
    gitSync.mockRestore();
  }
});

});
