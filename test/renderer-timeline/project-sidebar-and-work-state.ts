import { expect, it, vi } from 'vitest';
import type { SessionSummary } from "../../contracts/session.js";
import type { LocalProject } from "../../contracts/workspace/projects.js";

import { T0, boot, colorChoice, menuItem, projectMenu, settle, summary } from './context.js';

it('leaves file drops on the Folders card to its explicit folder-import owner', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [] }));
  api.addRootPath = vi.fn(async () => ({ ok: true, data: null }));
  const folder = new w.File(['folder'], 'folder-entry', { type: '' });
  const event = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [folder] } });
  w.document.getElementById('foldersCard')!.dispatchEvent(event);
  await settle();
  expect(api.addRootPath).toHaveBeenCalledExactlyOnceWith(folder);
  expect(api.dropFiles).not.toHaveBeenCalled();
});

it('keeps ordinary draft edits and parallel imports in the same draft lifetime', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const finishes: Array<(value: unknown) => void> = [];
  api.dropFiles = vi.fn(() => new Promise(resolve => finishes.push(resolve)));
  const paste = (name: string) => {
    const event = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new w.File(['image'], name, { type: 'image/png' })] } });
    w.document.getElementById('chatInput')!.dispatchEvent(event);
  };
  paste('first.png');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An ordinary edit while importing'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  paste('second.png');
  await vi.waitFor(() => expect(api.dropFiles).toHaveBeenCalledTimes(2));
  finishes[1]!({ ok: true, data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'second.png', size: 4, mimeType: 'image/png' }] });
  finishes[0]!({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'first.png', size: 4, mimeType: 'image/png' }] });
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('first.png');
  expect(w.document.getElementById('composerImages')!.textContent).toContain('second.png');
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelector('.toast')?.textContent ?? '').not.toContain('draft changed');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(0);
  w.document.getElementById('newChat')!.click(); await settle();
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
});

it.each(['new-same-key', 'a-b-a', 'opening-adopt-new', 'same-session-send-next', 'same-session-failed-send', 'plan-replaces', 'retry-replaces'])('rejects a late attachment import after the draft owner changed (%s)', async mode => {
  const a = { ...summary([]), id: 'draft-a', conversationId: 'chat-a' };
  const b = { ...summary([]), id: 'draft-b', conversationId: 'chat-b' };
  const options = mode === 'a-b-a' ? { sessions: [a, b] }
    : mode.startsWith('same-session') || mode.endsWith('replaces') ? { sessions: [a] }
    : mode === 'opening-adopt-new' ? { reserveOpenings: true } : {};
  const app = await boot([], false, [], [], options);
  const { w } = app;
  if (mode === 'a-b-a' || mode.startsWith('same-session') || mode.endsWith('replaces'))
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  if (mode === 'retry-replaces') {
    app.live.inputs.push({ id: 'failed-retry', sessionId: a.id, text: 'Restored failed message',
      mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
      createdAt: T0, conversationId: a.conversationId, error: 'Delivery failed' });
    await app.append([]);
  }
  let finish!: () => void;
  const attachment = { id: 'cccccccc-dddd-4eee-8fff-000000000000', name: 'late.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' };
  (w as any).api.dropFiles = vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true, data: [attachment] }); }));
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new w.File(['image'], 'late.png', { type: 'image/png' })] } });
  w.document.getElementById('chatInput')!.dispatchEvent(paste);
  await vi.waitFor(() => expect((w as any).api.dropFiles).toHaveBeenCalledTimes(1));

  if (mode === 'new-same-key') {
    w.document.getElementById('newChat')!.click();
  } else if (mode === 'a-b-a') {
    (w.document.querySelector('[data-id="draft-b"]') as HTMLButtonElement).click();
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  } else if (mode === 'opening-adopt-new') {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Adopt this opening';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(w.document.querySelector('.sess.is-sel')).not.toBeNull());
    w.document.getElementById('newChat')!.click();
  } else if (mode.startsWith('same-session')) {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    if (mode === 'same-session-failed-send')
      (w as any).api.sendInput = vi.fn(async () => ({ ok: false, error: 'test rejected send' }));
    input.value = 'Submitted draft';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    if (mode === 'same-session-send-next') await vi.waitFor(() => expect(app.live.sent).toHaveLength(1));
    else await vi.waitFor(() => expect((w as any).api.sendInput).toHaveBeenCalledTimes(1));
    await settle();
    input.value = 'Next draft'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  } else if (mode === 'plan-replaces') {
    (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Stage one', 'Stage two'] }));
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Turn this into a plan';
    w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(input.value).toBe(''));
  } else {
    (w.document.querySelector('.delivery-retry') as HTMLButtonElement).click();
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Restored failed message');
  }
  finish(); await settle();
  expect(w.document.querySelector('#composerImages .attachment-card')).toBeNull();
  expect(w.document.querySelector('.toast')?.textContent).toContain('draft changed');
});

it.each([false, true])('removes a project group in one click, keeps its chats and draft, and rejects an older refresh (selectedSkill=%s)', async selectedSkill => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Removed', path: '/removed', createdAt: 1 };
  const other = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Other', path: '/other', createdAt: 2 };
  const parent = { ...summary([]), projectId: project.id };
  const child = { ...summary([]), id: 'child-session', conversationId: 'child-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: parent.id, agentId: 'worker-1', task: 'Keep working' } };
  const { w, live } = await boot([], false, [], [project, other], { sessions: [parent, child] });
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  (w.document.querySelector('.worker-toggle') as HTMLButtonElement).click();
  (w.document.querySelector(`.project-heading > [data-new-project="${project.id}"]`) as HTMLButtonElement).click();
  input.value = 'Keep my draft';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  if (selectedSkill) {
    api.skillLibrary = () => Promise.resolve({ ok: true, data: { skills: [
      { id: 'review', name: 'Review', description: '', path: '/skills/review/SKILL.md', scope: 'managed', source: 'managed', managed: true, allowImplicitInvocation: true }
    ], roots: [], errors: [], includeInstructions: true } });
    input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
    w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  }
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('workspaceRefresh') as HTMLButtonElement).click();
  await settle();
  api.removeProject = vi.fn(async () => ({ ok: true, data: { ...project, ungrouped: true } }));
  projectMenu(w, project.id); menuItem(w, 'remove').click();
  await settle();
  expect(api.removeProject).toHaveBeenCalledExactlyOnceWith(project.id);
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  expect(w.document.querySelector(`[data-project-id="${other.id}"]`)).not.toBeNull();
  expect(w.document.querySelector(`#chatList > [data-id="${parent.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('#chatList > .worker-group [data-id="child-session"]')).not.toBeNull();
  expect(w.document.querySelector(`#projectList [data-id="${parent.id}"]`)).toBeNull();
  expect(input.value).toBe('Keep my draft');
  expect(input.placeholder).toBe('Ask anything…');
  finishList({ ok: true, data: { sessions: [parent, child], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: null, text: selectedSkill ? '/review\nKeep my draft' : 'Keep my draft' });
});

it('keeps the project visible when its removal fails, and lets the removal be tried again', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Keep', path: '/keep', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  (w as any).api.removeProject = vi.fn(async () => ({ ok: false, error: 'Could not save' }));
  projectMenu(w, project.id); menuItem(w, 'remove').click();
  await settle();
  expect(w.document.querySelector('.project-group')).not.toBeNull();
  projectMenu(w, project.id);
  expect(menuItem(w, 'remove').disabled).toBe(false);
  menuItem(w, 'remove').click(); await settle();
  expect((w as any).api.removeProject).toHaveBeenCalledTimes(2);
});

it('offers a new chat beside a project\'s menu, and its color as a submenu and removal inside it', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  const group = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  // Two buttons on the row: the primary new chat, then one "⋯"; a right click opens the same menu.
  expect([...group.querySelector('.project-heading')!.querySelectorAll('button')].map(b => b.className)).toEqual(['btn row-menu-button project-new', 'btn row-menu-button project-menu']);
  const button = projectMenu(w, project.id);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const menu = w.document.querySelector<HTMLElement>('.row-menu')!;
  expect(menu.getAttribute('role')).toBe('menu');
  expect([...menu.querySelectorAll<HTMLElement>('.row-menu-item')].map(item => item.dataset.rowAction)).toEqual(['color', 'remove']);
  expect(menuItem(w, 'remove').classList.contains('is-danger')).toBe(true);
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  // Keyboard: Down and Up move, Right opens the color submenu on the current choice, Left comes back.
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'remove'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(w.document.querySelectorAll('.row-menu').length).toBe(2);
  expect(w.document.activeElement).toBe(menuItem(w, 'color-none'));
  expect(menuItem(w, 'color-none').getAttribute('aria-checked')).toBe('true');
  w.document.querySelectorAll<HTMLElement>('.row-menu')[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(w.document.querySelectorAll('.row-menu').length).toBe(1);
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  // Escape closes it and gives focus back to the row's button.
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(w.document.querySelector('.row-menu')).toBeNull();
  expect(w.document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  // A right click on the row opens the same menu; a click elsewhere closes it.
  group.querySelector('.project-heading')!.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  expect(menuItem(w, 'color')).not.toBeNull();
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  expect(w.document.querySelector('.row-menu')).toBeNull();
  // New chat in this project: the row's own button, no longer a menu item.
  expect(projectMenu(w, project.id) && menuItem(w, 'new-chat')).toBeNull();
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  (w.document.querySelector(`.project-heading > [data-new-project="${project.id}"]`) as HTMLButtonElement).click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Message in Workspace…');
});

it('picks and clears project color without changing project membership', async () => {
  const project = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1
  };
  const { w } = await boot([], false, [], [project]);
  const api = (w as any).api;
  api.setProjectColor = vi.fn(async (_id: string, color: string | null) => ({ ok: true, data: { ...project, ...(color ? { color } : {}) } }));
  colorChoice(w, project.id, 'blue').click(); await settle();
  expect(api.setProjectColor).toHaveBeenNthCalledWith(1, project.id, 'blue');
  let refreshed = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  expect(refreshed.dataset.projectColor).toBe('blue');
  expect(colorChoice(w, project.id, 'blue').getAttribute('aria-checked')).toBe('true');
  menuItem(w, 'color-none').click(); await settle();
  expect(api.setProjectColor).toHaveBeenNthCalledWith(2, project.id, null);
  refreshed = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  expect(refreshed.dataset.projectColor).toBeUndefined();
  // Choosing the color it already has saves nothing.
  colorChoice(w, project.id, 'none').click(); await settle();
  expect(api.setProjectColor).toHaveBeenCalledTimes(2);
});

it.each([[false, true], [true, true], [true, false]])('preserves the keyboard color-save focus owner (focus moved: %s, focusin: %s)', async (moved, propagates) => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  const other = w.document.createElement('button'); other.textContent = 'Other control'; w.document.body.append(other);
  if (moved) {
    // An inactive Electron document can update activeElement without delivering focusin. Suppress that notification only; the real DOM still owns the current focused element.
    if (!propagates) w.document.addEventListener('focusin', event => event.stopImmediatePropagation(), { capture: true, once: true });
    other.focus();
  }
  finish({ ok: true, data: { ...project, color: 'blue' } }); await settle();
  const button = w.document.querySelector<HTMLButtonElement>('.project-menu')!;
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBe('blue');
  expect(w.document.activeElement === (moved ? other : button)).toBe(true);
});

it.each([false, true])('a rejected color-save keeps the color and the current focus owner (focus moved: %s)', async moved => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  // While the save is pending, its choices wait for the answer.
  expect(colorChoice(w, project.id, 'teal').disabled).toBe(true);
  menuItem(w, 'color').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  w.document.querySelector<HTMLElement>('.row-menu')?.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const button = w.document.querySelector<HTMLButtonElement>('.project-menu')!;
  const other = w.document.getElementById('chatInput')!;
  if (moved) other.focus();
  finish({ ok: false, error: 'Synthetic save refusal' }); await settle();
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBeUndefined();
  expect(w.document.activeElement === (moved ? other : button)).toBe(true);
  expect(colorChoice(w, project.id, 'blue').disabled).toBe(false);
});

it.each([false, true])('does not restore an old color-save focus after selecting another chat and returning (rejected: %s)', async rejected => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1 };
  const a = { ...summary([]), id: 'color-chat-a', projectId: project.id };
  const b = { ...summary([]), id: 'color-chat-b', projectId: project.id };
  const { w } = await boot([], true, [], [project], { sessions: [a, b] });
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  // A real click on a chat row moves focus to it; jsdom's click() does not, so do both.
  const choose = (id: string): void => { const row = w.document.querySelector<HTMLElement>(`[data-id="${id}"] [data-session-select]`)!; row.focus(); row.click(); };
  choose('color-chat-b'); await settle();
  choose('color-chat-a'); await settle();
  finish(rejected ? { ok: false, error: 'Synthetic save refusal' } : { ok: true, data: { ...project, color: 'blue' } }); await settle();
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBe(rejected ? undefined : 'blue');
  // The old save does not pull focus back to the project's menu button.
  expect(w.document.activeElement?.closest('.project-heading')).toBeNull();
});

it('names project colors in the interface language and keeps focus on the menu button after a pick', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  const api = (w as any).api;
  api.setProjectColor = vi.fn(async (_id: string, color: string | null) => ({ ok: true, data: { ...project, ...(color ? { color } : {}) } }));
  const group = (): HTMLElement => w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  // Each choice is the color itself, in words a screen reader can say, never the internal value.
  const { setLanguage } = await import("../../frontend/shared/i18n.js");
  expect(colorChoice(w, project.id, 'blue').textContent).toBe('Blue');
  setLanguage('de');
  expect(menuItem(w, 'color-blue').textContent).toBe('Blau');
  expect(menuItem(w, 'color').textContent).toBe('Farbe');
  setLanguage('en');

  // Picking repaints the sidebar. Focus must come back to the new menu button, not fall to the page.
  menuItem(w, 'color-teal').click(); await settle();
  expect(api.setProjectColor).toHaveBeenCalledWith(project.id, 'teal');
  expect(group().dataset.projectColor).toBe('teal');
  expect(w.document.activeElement).toBe(group().querySelector<HTMLButtonElement>('.project-menu'));
});

it('Share a folder creates a sidebar project and keeps it when an older list refresh finishes', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Shared', path: '/shared', createdAt: 1 };
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('workspaceRefresh') as HTMLButtonElement).click();
  await settle();
  api.addProject = vi.fn(async () => ({ ok: true, data: project }));
  api.addRoot = vi.fn();
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(api.addProject).toHaveBeenCalledTimes(1);
  expect(api.addRoot).not.toHaveBeenCalled();
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)?.open).toBe(true);
  finishList({ ok: true, data: { sessions: [], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  expect(input.placeholder).toContain('Shared');
  input.value = 'Work in this folder';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: project.id, text: 'Work in this folder' });
});

it('sends a fresh chat immediately through the selected provider', async () => {
  const { w, live } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Send through the selected provider';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Send through the selected provider', model: null, reasoningEffort: null });
});

it('cancelling Share a folder preserves the selected composer and creates no sidebar group', async () => {
  const { w } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  (w as any).api.addProject = vi.fn(async () => ({ ok: true, data: null }));
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this draft');
  expect(w.document.querySelector('.project-group')).toBeNull();
});

it('groups project chats and restores each project composer with its selected identity', async () => {
  const projects = [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 }, { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }];
  const { w, live, append } = await boot([], false, [], projects);
  const groups = w.document.querySelectorAll<HTMLDetailsElement>('.project-group');
  expect(groups).toHaveLength(2);
  expect([...groups].map(group => group.open)).toEqual([false, false]);
  expect(groups[0]!.querySelector('[data-id]')?.getAttribute('data-id')).toBe(summary([]).id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const choose = (id: string) => { (w.document.querySelector(`.project-heading > [data-new-project="${id}"]`) as HTMLButtonElement).click(); };
  choose(projects[0]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[0]!.id}"]`)!.open).toBe(true); input.value = 'Alpha draft';
  choose(projects[1]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(true); expect(input.value).toBe(''); input.value = 'Beta draft';
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe(''); input.value = 'Unfiled draft';
  choose(projects[0]!.id); expect(input.value).toBe('Alpha draft'); input.value = 'Alpha request';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: projects[0]!.id, text: 'Alpha request' });
  choose(projects[1]!.id); expect(input.value).toBe('Beta draft');
  const beta = w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!;
  beta.querySelector('summary')!.click(); await append([]);
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(false);
});

it('reorders whole project groups without changing chat selection, ownership or disclosure across refresh', async () => {
  const projects: LocalProject[] = [
    { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 },
    { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }
  ];
  const chats = projects.map((project, index) => ({ ...summary([]), id: `chat-${index}`, conversationId: `conversation-${index}`, projectId: project.id }));
  const { w, append, live } = await boot([], false, [], projects, { sessions: chats });
  const list = w.document.getElementById('sessionList')!;
  list.setPointerCapture = vi.fn(); list.hasPointerCapture = () => false;
  const groups = () => [...w.document.querySelectorAll<HTMLDetailsElement>('.project-group')];
  const ids = () => groups().map(group => group.dataset.projectId);
  const geometry = () => groups().forEach((group, index) => {
    group.getClientRects = () => [{ top: index * 100, height: 80 }] as unknown as DOMRectList;
    group.getBoundingClientRect = () => ({ top: index * 100, height: 80 }) as DOMRect;
  });
  const pointer = (target: Element | Window, type: string, y: number) => target.dispatchEvent(new w.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y
  }));
  groups()[0]!.querySelector('summary')!.click();
  expect(groups()[0]!.open).toBe(true);
  expect(groups().every(group => !group.hasAttribute('data-id'))).toBe(true);
  geometry();
  pointer(groups()[1]!.querySelector('summary')!, 'pointerdown', 110);
  pointer(list, 'pointermove', -20); pointer(w as unknown as Window, 'pointerup', -20);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  expect(groups()[1]!.open).toBe(true);
  for (const chat of chats) expect(w.document.querySelector(`[data-project-id="${chat.projectId}"] [data-id="${chat.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('.sess.is-sel')).toBeNull();
  await append([]);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  geometry();
  const beta = groups()[0]!.querySelector<HTMLElement>('summary')!;
  beta.focus(); beta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  expect(ids()).toEqual(projects.map(project => project.id));
  expect(w.document.activeElement).toBe(groups()[1]!.querySelector('summary'));
  const saved = w.localStorage.getItem('neuraflok.sidebar-order');
  pointer(groups()[0]!.querySelector('.project-menu')!, 'pointerdown', 10);
  pointer(list, 'pointermove', 500); pointer(w as unknown as Window, 'pointerup', 500);
  expect(w.localStorage.getItem('neuraflok.sidebar-order')).toBe(saved);
  expect(live.sent).toEqual([]);
});

it('keeps working state per chat and marks only completed background chats as unseen until opened', async () => {
  const startedAt = Date.now();
  const chats: SessionSummary[] = [
    { ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'], updatedAt: startedAt,
      lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 },
    { ...summary([]), id: 'chat-b', title: 'Beta', conversationId: 'conversation-b', chatIds: ['conversation-b'], updatedAt: startedAt - 1,
      lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 }
  ];
  const { w } = await boot([], false, [], [], { sessions: chats });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  const refresh = async () => { (w.document.getElementById('workspaceRefresh') as HTMLButtonElement).click(); await settle(); };
  let observedAt = Date.now();
  const nextAt = () => ++observedAt;

  row('chat-a').click();
  expect(row('chat-a').querySelector('.session-status.is-active')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-active')).not.toBeNull();

  const backgroundCompletedAt = nextAt();
  Object.assign(chats[1]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: backgroundCompletedAt,
    lastTurnEndAt: backgroundCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: backgroundCompletedAt
  });
  await refresh();
  expect(row('chat-a').querySelector('.session-status.is-active')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')?.getAttribute('aria-label')).toBe('New response');

  row('chat-b').click();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
  await settle();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();
  expect(w.localStorage.getItem('neuraflok.sidebar-completion-seen')).toContain('chat-b');

  const selectedWorkingAt = nextAt();
  Object.assign(chats[1]!, { lastToolCallAt: selectedWorkingAt, activityExpiresAt: selectedWorkingAt + 60_000, updatedAt: selectedWorkingAt });
  await refresh();
  expect(row('chat-b').querySelector('.session-status.is-active')).not.toBeNull();
  const selectedCompletedAt = nextAt();
  Object.assign(chats[1]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: selectedCompletedAt,
    lastTurnEndAt: selectedCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: selectedCompletedAt
  });
  await refresh();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();

  const alphaCompletedAt = nextAt();
  Object.assign(chats[0]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: alphaCompletedAt,
    lastTurnEndAt: alphaCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: alphaCompletedAt
  });
  await refresh();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();
});

it('keeps the sidebar working spinner on one continuous phase across activity repaints', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  try {
    const chats: SessionSummary[] = [{
      ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'],
      updatedAt: 10_000, lastToolCallAt: 10_000, activityExpiresAt: 70_000
    }];
    const { w } = await boot([], false, [], [], { sessions: chats });
    const spinner = () => w.document.querySelector<HTMLElement>('.sess[data-id="chat-a"] .session-status.is-active')!;
    expect(spinner().style.animationDelay).toBe('-100ms');

    clock.mockReturnValue(10_450);
    chats[0]!.lastToolCallAt = 10_450;
    chats[0]!.updatedAt = 10_450;
    (w.document.getElementById('workspaceRefresh') as HTMLButtonElement).click();
    await settle();
    // The row node was rebuilt, but the spinner resumes the wall-clock phase instead of 0deg.
    expect(spinner().style.animationDelay).toBe('-550ms');
  } finally {
    clock.mockRestore();
  }
});

it('keeps unseen completions unread through failed and stale A-to-B-to-A detail loads', async () => {
  const chats: SessionSummary[] = [
    { ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'] },
    { ...summary([]), id: 'chat-b', title: 'Beta', conversationId: 'conversation-b', chatIds: ['conversation-b'] }
  ];
  const { w } = await boot([], false, [], [], { sessions: chats });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  let observedAt = Date.now();
  for (const chat of chats) {
    const completedAt = ++observedAt;
    Object.assign(chat, {
      activeTurnId: null,
      activityExpiresAt: null,
      lastAssistantFinalAt: completedAt,
      lastTurnEndAt: completedAt,
      lastTurnOutcome: 'completed',
      updatedAt: completedAt
    });
  }
  (w.document.getElementById('workspaceRefresh') as HTMLButtonElement).click();
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  type Reply = (value: unknown) => void;
  const pending: Array<{ id: string; reply: Reply }> = [];
  const api = (w as any).api;
  api.getSession = vi.fn((id: string) => new Promise(resolve => pending.push({ id, reply: resolve })));
  const detail = (sum: SessionSummary) => ({ ok: true, data: { summary: sum, events: [], total: 0, nextFrom: 0 } });

  // A failed current read is not a review receipt.
  row('chat-b').click();
  await vi.waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b']));
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
  pending[0]!.reply({ ok: false, error: 'B detail unavailable' });
  await settle();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  // Returning to A creates a new selection/load generation. Neither the old A response nor the intervening B response may acknowledge work just because the selected id later matches.
  row('chat-a').click();
  await vi.waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a']));
  row('chat-b').click();
  await vi.waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a', 'chat-b']));
  row('chat-a').click();
  await vi.waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a', 'chat-b', 'chat-a']));

  pending[1]!.reply(detail(chats[0]!));
  pending[2]!.reply(detail(chats[1]!));
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  pending[3]!.reply(detail(chats[0]!));
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
});
