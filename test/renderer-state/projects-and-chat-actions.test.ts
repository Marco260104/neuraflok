import { closeRowMenus, mountChat, projectSidebarFixture, rowMenuItem, settle } from './context.js';
import { expect, it, vi } from 'vitest';

it('starts project groups collapsed and deliberately expands the project selected for a new chat', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  expect(group().open).toBe(false);
  // A new chat is the row's own button, beside its menu, not an item inside it.
  expect(rowMenuItem(group().querySelector('.project-heading')!, 'new-chat')).toBeNull();
  const create = group().querySelector<HTMLButtonElement>('.project-heading > .project-new')!;
  expect(create.getAttribute('aria-label')).toBe('New chat in this project');
  expect(create.nextElementSibling?.classList.contains('project-menu')).toBe(true);
  create.click();
  expect(group().open).toBe(true);
});

it('commits a project summary click before an immediate state repaint replaces its details node', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  (group().querySelector(`[data-id="${session.id}"]`) as HTMLButtonElement).click();
  expect(group().open).toBe(true);
  const clicked = group();
  clicked.querySelector('summary')!.click();
  expect(clicked.open).toBe(false);
  mounted.push(structuredClone(mounted.state));
  expect(group()).not.toBe(clicked);
  expect(group().open).toBe(false);
  await settle();
  expect(group().open).toBe(false);

  // Native keyboard activation dispatches the same cancelable click with detail 0.
  group().querySelector('summary')!.dispatchEvent(new mounted.window.MouseEvent('click', {
    bubbles: true, cancelable: true, detail: 0
  }));
  expect(group().open).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(group().open).toBe(true);
});

it('opens a provider session from its row menu', async () => {
  const session = {
    id: 'linked-session', title: 'Linked chat', conversationId: 'ds-00000000-0000-4000-8000-000000000001',
    chatIds: ['ds-00000000-0000-4000-8000-000000000001'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const openWebProvider = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    openWebProvider
  });
  const doc = mounted.window.document;
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(row()).not.toBeNull());
  const item = rowMenuItem(row(), 'open')!;
  expect(item.textContent).toContain('Open provider');
  item.click();
  await vi.waitFor(() => expect(openWebProvider).toHaveBeenCalledWith('deepseek'));
});

it('keeps strict chat allowlisting separate from Block and exposes explicit Trust on session rows', async () => {
  const session = {
    id: 'strict-session', title: 'Strict policy chat', conversationId: 'strict-chat-0001', chatIds: ['strict-chat-0001'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const workerSession = {
    ...session,
    id: 'strict-worker-session', title: 'Strict worker chat', conversationId: 'strict-worker-chat-0001',
    chatIds: ['strict-worker-chat-0001'],
    origin: { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'owned work' }
  };
  const setSessionTrusted = vi.fn(async () => ({ ok: true, data: [session.conversationId] }));
  const setSessionBlocked = vi.fn(async () => ({ ok: true, data: [session.conversationId] }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session, workerSession], activeId: null, pressure: [], blocked: [], trusted: []
    } }),
    setSessionTrusted,
    setSessionBlocked
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const primeRow = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  const workerRow = () => doc.querySelector<HTMLElement>(`[data-id="${workerSession.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(primeRow(), 'trust')).not.toBeNull());
  closeRowMenus(doc);
  expect(rowMenuItem(workerRow(), 'trust')).toBeNull();
  expect(doc.querySelector('.row-menu [data-row-action="block"]')).not.toBeNull();
  closeRowMenus(doc);

  rowMenuItem(primeRow(), 'trust')!.click();
  await vi.waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, session.conversationId, true));
  expect(setSessionBlocked).not.toHaveBeenCalled();

  rowMenuItem(primeRow(), 'block')!.click();
  await vi.waitFor(() => expect(setSessionBlocked).toHaveBeenCalledWith(session.id, true));
});

it('shows committed resume inheritance as trusted and revokes it through the current row', async () => {
  const source = 'strict-resume-source-0001';
  const current = 'strict-resume-current-0001';
  const session = {
    id: 'strict-resume-session', title: 'Resumed trusted chat', conversationId: current, chatIds: [source, current],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: 'handoff-resume-0001', lastHandoffAt: 1,
    lastCommittedResumeHandoffId: 'handoff-resume-0001',
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const setSessionTrusted = vi.fn(async () => ({ ok: true, data: [] }));
  const setSessionBlocked = vi.fn(async () => ({ ok: true, data: [] }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [source]
    } }),
    setSessionTrusted,
    setSessionBlocked
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
  const trust = rowMenuItem(row(), 'trust')!;
  expect(trust.textContent).toBe('Untrust chat');
  expect(doc.querySelector('.row-menu [data-row-action="block"]')!.textContent).toBe('Block chat');
  trust.click();
  await vi.waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, current, false));
});

it('offers a chat\'s actions in one menu, by kind of row, and opens it with a right click too', async () => {
  const base = { startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
  const chat = { ...base, id: 'menu-chat-0001', title: 'A chat', conversationId: 'ds-00000000-0000-4000-8000-000000000002',
    chatIds: ['ds-00000000-0000-4000-8000-000000000002'] };
  const loose = { ...base, id: 'menu-loose-0001', title: '', conversationId: null, chatIds: [] };
  const deleteSession = vi.fn(async () => ({ ok: true, data: true }));
  const openWebProvider = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [chat, loose], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    deleteSession, openWebProvider
  });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  await vi.waitFor(() => expect(row(chat.id)).not.toBeNull());
  // One button on the row, no loose icons.
  expect(row(chat.id).querySelectorAll('.sess-actions button').length).toBe(1);
  const actions = (): Array<string | undefined> => [...doc.querySelectorAll<HTMLElement>('.row-menu .row-menu-item')].map(item => item.dataset.rowAction);
  rowMenuItem(row(chat.id), 'rename');
  expect(actions()).toEqual(['pin', 'rename', 'open', 'block', 'remove']);
  expect(doc.querySelector('.row-menu [data-row-action="remove"]')!.classList.contains('is-danger')).toBe(true);
  closeRowMenus(doc);
  // A row that is not a chat offers only what applies to it.
  await vi.waitFor(() => expect(row(loose.id)).not.toBeNull());
  rowMenuItem(row(loose.id), 'block');
  expect(actions()).toEqual(['block', 'remove']);
  closeRowMenus(doc);
  // A right click opens the same menu; its items run their action.
  row(chat.id).dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  doc.querySelector<HTMLButtonElement>('.row-menu [data-row-action="open"]')!.click();
  await vi.waitFor(() => expect(openWebProvider).toHaveBeenCalledWith('deepseek'));
  expect(doc.querySelector('.row-menu')).toBeNull();
});

it('names a chat in place: Enter saves, Escape keeps the old name, empty restores the provider title, repaints keep the field', async () => {
  const session = {
    id: 'rename-session-0001', title: 'Provider title', conversationId: 'ds-00000000-0000-4000-8000-000000000003',
    chatIds: ['ds-00000000-0000-4000-8000-000000000003'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const renameSession = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    renameSession
  });
  const doc = mounted.window.document;
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  const field = () => row().querySelector<HTMLInputElement>('.sess-rename');
  await vi.waitFor(() => expect(row().querySelector('.row-menu-button')).not.toBeNull());
  expect(field()).toBeNull();
  const press = (key: string) => field()!.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const type = (text: string) => { field()!.value = text; field()!.dispatchEvent(new mounted.window.Event('input', { bubbles: true })); };

  // Escape: nothing is saved, the title is back.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  expect(field()!.value).toBe('Provider title');
  type('Never saved');
  press('Escape');
  await vi.waitFor(() => expect(field()).toBeNull());
  expect(renameSession).not.toHaveBeenCalled();
  expect(row().querySelector('.sess-top b')!.textContent).toBe('Provider title');

  // The sidebar repaints while the user types; the field and its text survive.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  type('  Release   prep  ');
  const editing = field();
  mounted.push(structuredClone(mounted.state));
  await new Promise(resolve => setTimeout(resolve, 50));
  // The same node: an input method's composition would not survive a replaced field.
  expect(field()).toBe(editing);
  expect(field()?.value).toBe('  Release   prep  ');
  press('Enter');
  await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith(session.id, 'Release   prep'));

  // Empty restores the provider title.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  type('   ');
  press('Enter');
  await vi.waitFor(() => expect(renameSession).toHaveBeenLastCalledWith(session.id, null));
});

it('searches chats in a dialog opened beside the app name: recent chats first, then marked matches', async () => {
  const base = { conversationId: null, chatIds: [], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
  const listed = { ...base, id: 'search-listed-0001', title: 'Listed chat', conversationId: 'search-listed-conversation' };
  let indexed = 1;
  const searchSessions = vi.fn(async (query: string) => ({ ok: true, data: query === 'bridge' ? {
    results: [{ id: 'search-hit-0001', title: 'Release planning', projectId: null,
      snippet: { text: '…then the bridge gets its installer.', matches: [[10, 16]] } }],
    indexed, total: 3 } : { results: [], indexed: 3, total: 3 } }));
  const getSession = vi.fn(async (id: string) => ({ ok: true, data: { summary: { ...base, id, title: 'Release planning' }, events: [], total: 0, nextFrom: 1 } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [listed], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    searchSessions, getSession
  });
  const doc = mounted.window.document;
  const field = doc.getElementById('chatSearch') as HTMLInputElement;
  const results = doc.getElementById('searchResults')!;
  const lists = doc.getElementById('sessionList')!;
  const dialog = doc.getElementById('searchDialog') as HTMLDialogElement;
  await vi.waitFor(() => expect(doc.querySelector('[data-id="search-listed-0001"]')).not.toBeNull());
  // No search field in the sidebar: one icon beside the app name opens the dialog.
  expect(doc.querySelector('.sidebar #chatSearch')).toBeNull();
  expect(dialog.open).toBe(false);
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  expect(doc.activeElement).toBe(field);
  // Before anything is typed: the most recent chats.
  await vi.waitFor(() => expect(results.querySelector('.search-heading')?.textContent).toBe('Recent'));
  expect([...results.querySelectorAll('.search-result b')].map(title => title.textContent)).toEqual(['Listed chat']);

  field.value = 'bridge';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(results.querySelector('.search-snippet')).not.toBeNull());
  // The chat lists keep their place behind the dialog.
  expect(lists.hidden).toBe(false);
  expect((doc.getElementById('chatSearchClear') as HTMLButtonElement).hidden).toBe(false);
  expect(results.querySelector('.search-result b')!.textContent).toBe('Release planning');
  expect([...results.querySelectorAll('.search-snippet mark')].map(mark => mark.textContent)).toEqual(['bridge']);
  // Indexing is not done yet: the result says so, and asks again until it is.
  expect(results.querySelector('.search-status')!.textContent).toContain('1 of 3');
  indexed = 3;
  await vi.waitFor(() => expect(results.querySelector('.search-status')).toBeNull());

  // Opening a result closes the dialog and opens the chat.
  (results.querySelector('.search-result') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith('search-hit-0001', expect.anything()));

  // Opened again (from the View menu), the last query is still there, selected, and the open chat is marked.
  (doc.getElementById('viewMenu') as HTMLButtonElement).click();
  (doc.querySelector('.row-menu [data-row-action="search"]') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  await vi.waitFor(() => expect(results.querySelector('.search-result')!.classList.contains('is-sel')).toBe(true));

  field.value = 'nothing';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(results.textContent).toContain('No chats match'));

  // The clear button empties the query and brings the recent chats back.
  (doc.getElementById('chatSearchClear') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(results.querySelector('.search-heading')).not.toBeNull());
  expect(field.value).toBe('');
  // A click on the backdrop lands on the dialog itself and closes it.
  dialog.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => expect(dialog.open).toBe(false));
});

it.each([['Win32', 'ctrlKey', 'metaKey'], ['MacIntel', 'metaKey', 'ctrlKey']] as const)(
  'opens chat search with the primary shortcut on %s, never from the terminal, and says when results were capped', async (platform, primary, other) => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, platform });
  try {
    const base = { conversationId: null, chatIds: [], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
      lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
      estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
    const listed = { ...base, id: 'search-shortcut-0001', title: 'Listed chat', conversationId: 'search-shortcut-conversation' };
    const mounted = await mountChat({}, [], {
      listProjects: async () => ({ ok: true, data: [] }),
      listSessions: async () => ({ ok: true, data: { sessions: [listed], activeId: null, pressure: [], blocked: [], trusted: [] } }),
      searchSessions: async () => ({ ok: true, data: { results: [{ id: 'search-shortcut-0001', title: 'Listed chat', projectId: null }],
        indexed: 1, total: 1, limited: true } })
    });
    const doc = mounted.window.document;
    const field = doc.getElementById('chatSearch') as HTMLInputElement;
    await vi.waitFor(() => expect(doc.querySelector('[data-id="search-shortcut-0001"]')).not.toBeNull());
    const press = (target: EventTarget, modifier: string) =>
      target.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'k', [modifier]: true, bubbles: true, cancelable: true }));
    expect(press(doc.body, other)).toBe(true);
    expect(doc.activeElement).not.toBe(field);
    // Ctrl+K deletes to the end of the line in a shell; the terminal keeps it.
    const terminal = doc.createElement('div');
    terminal.className = 'xterm';
    const input = terminal.appendChild(doc.createElement('textarea'));
    doc.body.append(terminal);
    input.focus();
    expect(press(input, primary)).toBe(true);
    expect(doc.activeElement).toBe(input);
    expect(press(doc.body, primary)).toBe(false);
    expect((doc.getElementById('searchDialog') as HTMLDialogElement).open).toBe(true);
    expect(doc.activeElement).toBe(field);

    field.value = 'listed';
    field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(doc.getElementById('searchResults')!.textContent)
      .toContain('Showing the first 1 matches. Add a word to narrow them down.'));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('shows an inherited Block ahead of Trust on a committed resumed row', async () => {
  const source = 'strict-resume-blocked-source-0001';
  const current = 'strict-resume-blocked-current-0001';
  const session = {
    id: 'strict-resume-blocked-session', title: 'Resumed blocked chat', conversationId: current, chatIds: [source, current],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: 'handoff-resume-blocked-0001', lastHandoffAt: 1,
    lastCommittedResumeHandoffId: 'handoff-resume-blocked-0001',
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session], activeId: null, pressure: [], blocked: [source], trusted: [source]
    } })
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
  expect(doc.querySelector('.row-menu [data-row-action="block"]')!.textContent).toBe('Release chat');
  expect(doc.querySelector('.row-menu [data-row-action="trust"]')!.textContent).toBe('Trust chat');
});

it('saves strict chat allowlisting and disables the unattributed switch while strict mode is on', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const strict = doc.getElementById('strictChatAllowlist') as HTMLInputElement;
  const unattributed = doc.getElementById('allowUnattributedCalls') as HTMLInputElement;
  const copy = strict.closest('.setting')!.textContent ?? '';
  expect(copy).toContain("Only chats you trust can use this computer's tools.");
  expect(copy).toContain('Existing chats start untrusted');
  expect(copy).toMatch(/sidebar.*Trust/i);
  expect(copy).not.toContain('Sessions');

  strict.checked = true;
  strict.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.some(call => call.multiAgent?.strictChatAllowlist === true)).toBe(true));

  const next = structuredClone(mounted.state);
  next.config.multiAgent.strictChatAllowlist = true;
  mounted.push(next);
  expect(unattributed.disabled).toBe(true);
});
