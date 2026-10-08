import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  handlers,
  getConfig,
  saveConfig,
  createSession,
  getSession,
  readDurable,
  writeDurableNow,
  startBridge,
  cleanSessionName,
  save,
  ipcFixture,
} from './ipc-context.js';
describe('settings IPC behavior', () => {
it('keeps the reported interface language and the extension preferences through a Settings save', async () => {
  // Neither is part of the settings form. The save replaces the whole `ui` object, so both must be carried through, or the extension would lose its language and its kept preferences.
  await handlers.get('ui:language')!(null, 'en');
  expect(getConfig().ui.language).toBe('en');
  expect(await handlers.get('ui:language')!(null, 'klingon')).toMatchObject({ ok: false });
  expect(getConfig().ui.language).toBe('en');
  await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, browserPreferences: { overwrite: false, durations: true } } });
  const base = getConfig();
  expect(await save({ ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' : 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.language).toBe('en');
  expect(getConfig().ui.browserPreferences).toEqual({ overwrite: false, durations: true });
});

it('saves the followOutput display switch from Settings', async () => {
  const key = 'followOutput' as const;
  const base = getConfig();
  const wanted = !(base.ui[key] ?? (key === 'followOutput'));
  expect(await save({ ...base, ui: { ...base.ui, [key]: wanted } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui[key]).toBe(wanted);
  // A stale snapshot that never touched the switch keeps the saved value.
  expect(await save({ ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' : 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui[key]).toBe(wanted);
});

it('saves Auto-select Skills through Settings and preserves it across a stale unrelated save', async () => {
  const base = getConfig();
  const wanted = !(base.ui.autoSelectSkills ?? false);
  expect(await save({ ...base, ui: { ...base.ui, autoSelectSkills: wanted } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.autoSelectSkills).toBe(wanted);
  expect(await save({ ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' : 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.autoSelectSkills).toBe(wanted);
});

it('names a chat with one clean line, and clears the name for an empty one', async () => {
  expect(cleanSessionName('  Release\nprep\t\u0000now  ')).toBe('Release prep now');
  expect(cleanSessionName('x'.repeat(300))).toHaveLength(120);
  expect(cleanSessionName(' \u2028 ')).toBeNull();
  expect(cleanSessionName(null)).toBeNull();
  const session = await createSession({ conversationId: 'ipc-rename-chat', title: 'From ChatGPT' });
  const rename = (title: unknown) => handlers.get('sessions:rename')!(null, { id: session.id, title }) as Promise<unknown>;
  await rename('  My   name ');
  expect(await getSession(session.id)).toMatchObject({ title: 'My name', titleSource: 'manual' });
  await rename('');
  expect((await getSession(session.id))?.title).toBe('From ChatGPT');
  expect(await rename(42)).toMatchObject({ ok: false });
  expect(await handlers.get('sessions:rename')!(null, { id: 'missing-session-0001', title: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Session not found') });
});

it('enabling strict chat allowlisting keeps existing chats untrusted', async () => {
  const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
  resetTrustedChatsForTests();
  const conversationId = 'strict-existing-chat-stays-untrusted';
  await createSession({ title: 'Existing chat before strict mode', conversationId });
  const base = getConfig();
  try {
    expect(await save({ ...base, multiAgent: { ...base.multiAgent, strictChatAllowlist: true } }, base)).toMatchObject({ ok: true });
    expect(getConfig().multiAgent.strictChatAllowlist).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
  } finally {
    resetTrustedChatsForTests();
  }
});

it('trusts a strict NEURAFLOK opening through the configured session-policy fence only after exact bind', async () => {
  const outbox = await import('../backend/domains/sessions/input/input.js');
  const { isChatTrusted, resetTrustedChatsForTests } = await import('../backend/domains/sessions/continuity/trusted-chats.js');
  resetTrustedChatsForTests();
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const base = getConfig();
  const id = 'f0f00015-1111-4111-8111-111111111111';
  const conversationId = 'f0f00016-1111-4111-8111-111111111111';
  try {
    expect(await save({ ...base, multiAgent: { ...base.multiAgent, strictChatAllowlist: true } }, base)).toMatchObject({ ok: true });
    const row = await outbox.enqueueInput({ id, sessionId: null, text: 'Strict composer opening', mode: 'auto',
      dueAt: Date.now(), model: null, reasoningEffort: null });
    expect(await outbox.claimBrowserInput(row.id, 'strict-ipc-opening', null, true)).not.toBeNull();
    expect(await outbox.authorizeBrowserInput(row.id, 'strict-ipc-opening', null)).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
    expect(await outbox.bindBrowserInputProject(row.id, 'strict-ipc-opening', conversationId)).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(true);
  } finally {
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
    resetTrustedChatsForTests();
  }
});

it('saves port choices, merges stale snapshots and serializes concurrent port edits', async () => {
  const ports = await import('../backend/domains/browser/bridge-ports.js');
  const bridge = await import('../backend/domains/browser/bridge.js');
  const selection = vi.spyOn(ports, 'bridgePortSelection').mockReturnValue({ candidates: [0], overridden: false });
  try {
    const base = getConfig();
    const results = await Promise.all([8767, 8768].map(browserBridgePort => save({ ...base, ui: { ...base.ui, browserBridgePort } }, base)));
    expect(results.every(result => result.ok)).toBe(true);
    const active = bridge.bridgePort();
    expect(await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).toMatchObject({ ok: true });
    expect(getConfig().ui).toMatchObject({ browserBridgePort: 8768, theme: 'light' });
    expect(bridge.bridgePort()).toBe(active);
  } finally { selection.mockRestore(); }
});

it('rejects occupied port edits through Settings IPC and preserves the old bridge and disk', async () => {
  const http = await import('node:http');
  const ports = await import('../backend/domains/browser/bridge-ports.js');
  const bridge = await import('../backend/domains/browser/bridge.js');
  await startBridge(); const old = bridge.bridgePort();
  const blocker = http.createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const selection = vi.spyOn(ports, 'bridgePortSelection').mockReturnValue({ candidates: [(blocker.address() as { port: number }).port], overridden: false });
  try {
    const base = getConfig(); const disk = await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8');
    expect(await save({ ...base, ui: { ...base.ui, browserBridgePort: 8767 } }, base)).toMatchObject({ ok: false });
    expect(getConfig()).toBe(base); expect(bridge.bridgePort()).toBe(old);
    expect(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8')).toBe(disk);
  } finally { selection.mockRestore(); await new Promise<void>(resolve => blocker.close(() => resolve())); }
});

it('enforces the environment override for explicit edits while accepting unrelated saves', async () => {
  const base = getConfig();
  // vitest.config.ts supplies the real NEURAFLOK_BRIDGE_PORTS=0 override.
  const result = await save({ ...base, ui: { ...base.ui, browserBridgePort: 8767 } }, base);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('NEURAFLOK_BRIDGE_PORTS') });
  expect(getConfig().ui.browserBridgePort).toBe('auto');
  const unrelated = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
  expect(unrelated).toMatchObject({ ok: true, data: { bridge: { portOverridden: true } } });
});

it('persists arbitrary colors through Settings IPC and preserves concurrent per-field edits', async () => {
  const { defaultAppearance } = await import('../contracts/appearance-settings.js');
  const base = getConfig();
  const appearance = defaultAppearance(); appearance.dark.sidebar = '#fa89c2'; appearance.font = 'serif';
  expect(await save({ ...base, ui: { ...base.ui, appearance } }, base)).toMatchObject({ ok: true });
  const nextAppearance = defaultAppearance(); nextAppearance.dark.accent = '#4a6be2';
  expect(await save({ ...base, ui: { ...base.ui, appearance: nextAppearance } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.appearance).toMatchObject({ font: 'serif', dark: { sidebar: '#fa89c2', accent: '#4a6be2' } });
  const current = getConfig();
  expect(await save({ ...current, ui: { ...current.ui, appearance: { ...current.ui.appearance, fontSize: 100 } } }, current)).toMatchObject({ ok: false });
  expect(getConfig().ui.appearance).toEqual(current.ui.appearance);
});

it('does not expose removed setup-profile or public-tunnel actions', () => {
  expect(handlers.has('setup:profile')).toBe(false);
  expect(handlers.has('binary:pick')).toBe(false);
  expect(handlers.has('connection:connect')).toBe(false);
  expect(handlers.has('connection:disconnect')).toBe(false);
});

it.each([true, false])('forwards canonical input commitment even when a legacy writer proposes recording=%s', async recording => {
  const input = await import('../backend/domains/sessions/input/input.js');
  const store = await import('../backend/domains/sessions/history/store.js');
  const previous = await readDurable('session-input');
  const session = await createSession({ title: 'Input commitment fixture', conversationId: 'input-commitment-fixture' });
  const id = '30000000-0000-4000-8000-000000000001';
  try {
    await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: recording } });
    await writeDurableNow('session-input', [{ id, sessionId: session.id, text: 'Delivered fixture', mode: 'auto', model: null,
      reasoningEffort: null, dueAt: 100, createdAt: 100, state: 'sent', owner: null, conversationId: 'input-commitment-fixture',
      messageId: `input:${id}`, offeredAt: 200, deliveredAt: 300, historyRecorded: false,
      toolImages: [{ name: 'invalid.webp', dataUrl: 'data:image/webp;base64,YQ==' }] }]);
    input.resetInputForTests();
    const result = await handlers.get('sessions:outbox')!(null, undefined) as any;
    expect(result.ok).toBe(true);
    const row = result.data[0];
    expect(getConfig().sessions).toMatchObject({ record: true, retainDays: 0 });
    expect(row.historyAnchored).toBe(true);
    expect(row.historyRecorded).not.toBe(true);
    expect((await readDurable<any[]>('session-input'))![0].historyAnchored).toBe(true);
    const canonical = (await store.readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ inputId: id, time: 200 });
  } finally {
    await writeDurableNow('session-input', previous ?? []);
    input.resetInputForTests();
  }
});

});
