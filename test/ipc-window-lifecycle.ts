import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  handlers,
  appendEvent,
  createSession,
  rebindSession,
  registerIpc,
  app,
  shell,
  dialog,
  ipcFixture,
} from './ipc-context.js';
describe('renderer pushes after the window is gone', () => {
  it('does not touch a destroyed BrowserWindow, whose members all throw', async () => {
    // Electron keeps the object after the window is destroyed, so the existing `?.` on `getWindow()` never fires: the reference is truthy and reading `.webContents` throws. The log push is the one that matters, because `onLog` listeners run synchronously on the writer's stack — during a quit that turned every teardown log line into a throw inside the teardown step that wrote it.
    const { logInfo } = await import('../backend/infrastructure/settings/logger.js');
    let touchedWebContents = false;
    const destroyed = {
      isDestroyed: () => true,
      get webContents() {
        touchedWebContents = true;
        throw new Error('Object has been destroyed');
      }
    } as unknown as import('electron').BrowserWindow;

    registerIpc(
      () => destroyed,
      () => {}
    );
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});

describe('Stop IPC exact session and turn authority', () => {
  it('requires an explicit current turn and cannot stop a replacement conversation', async () => {
    const invoke = (payload: unknown) => handlers.get('sessions:stopTurn')!(null, payload) as Promise<any>;
    const conversationId = 'f1111111-aaaa-4bbb-8ccc-111111111111';
    const session = await createSession({ title: 'Stop IPC', conversationId });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'ipc-stop-one' });
    expect((await invoke({ id: session.id })).ok).toBe(false);
    expect(await invoke({ id: session.id, expectedTurnId: 'other-turn' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    // A stored historical start alone cannot authorize stopping a browser turn.
    expect(await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    await rebindSession(session.id, conversationId, 'f2222222-aaaa-4bbb-8ccc-111111111111');
    expect((await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).ok).toBe(false);
    const missing = await createSession({ title: 'No browser ownership', conversationId: null });
    expect(await invoke({ id: missing.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'session_not_recorded' });
  });
});

it('saves a diagnostics report through the renderer channel without personal details', async () => {
  const { flushLogFile, initLogFile, logInfo } = await import('../backend/infrastructure/settings/logger.js');
  const home = path.join(ipcFixture.dir, 'home-jane');
  const clients = path.join(home, 'Acme Clients');
  await fs.mkdir(clients, { recursive: true });
  initLogFile(path.join(ipcFixture.dir, 'app.log'));
  logInfo(`tool read rejected: ENOENT, open '${path.join(clients, 'invoice 7.xlsx')}' for jane@example.com`);
  logInfo('bridge: gave up on worker:run-1:worker-2 — the chat this app opened did not report back in time');
  await flushLogFile();
  await createSession({ title: 'Quarterly tax return draft', conversationId: 'diagnostics-report-session' });
  const getPath = app.getPath;
  const target = path.join(ipcFixture.dir, 'report.txt');
  (app as { getPath: (name: string) => string }).getPath = (name: string) => name === 'home' ? home : ipcFixture.dir;
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: target } as never);
  try {
    expect(await handlers.get('diagnostics:saveReport')!(null, undefined)).toEqual({ ok: true, data: { saved: true, name: 'report.txt' } });
  } finally {
    (app as { getPath: typeof getPath }).getPath = getPath;
  }
  const report = await fs.readFile(target, 'utf8');
  expect(report).toContain('# NEURAFLOK diagnostics report');
  expect(report).toContain('did not report back in time');
  expect(report).toMatch(/open '~[\\/]<p:[0-9a-f]{4}>[\\/]<p:[0-9a-f]{4}>\.xlsx'/);
  for (const personal of ['home-jane', 'Acme', 'invoice', 'jane@example.com', 'Quarterly tax return']) expect(report).not.toContain(personal);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(target);
});

