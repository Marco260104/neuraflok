import { catalogue, mountChat, projectSidebarFixture, settle } from './context.js';
import { expect, it, vi } from 'vitest';

it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

it('searches the whole OpenRouter catalogue and clearing restores newest-first paging', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  const search = doc.getElementById('goalModelSearch') as HTMLInputElement | null;
  expect(search).not.toBeNull();
  // It says what it does: it searches the whole catalogue, not a model field.
  expect([search!.placeholder, search!.getAttribute('aria-label')]).toEqual(['Search models', 'Search models']);
  search!.value = 'model-44';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('model-44');
  expect([...doc.querySelectorAll<HTMLElement>('.goal-model')].map(row => row.dataset.model)).toEqual(['vendor44/model-44']);

  search!.value = '';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('');
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(false);
});

it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: 'vendor1/model-1' });
});

it('saves GLM High and Max from catalogue-specific options and drops unsupported levels on model selection', async () => {
  const glm = { id: 'z-ai/glm-5.3', name: 'GLM 5.3', created: 100, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const plain = { id: 'plain/model', name: 'Plain', created: 1, contextLength: 1000 };
  const mounted = await mountChat({ hasGoalKey: true }, [glm, plain]);
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelector('[data-model="z-ai/glm-5.3"]') as HTMLButtonElement).click();
  await settle();
  const select = doc.getElementById('goalReasoning') as HTMLSelectElement;
  expect([...select.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  for (const reasoning of ['high', 'max']) {
    select.value = reasoning;
    select.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: glm.id, reasoning });
  }
  (doc.querySelector('[data-model="plain/model"]') as HTMLButtonElement).click();
  await settle();
  expect([...select.options].map(option => option.value)).toEqual(['default']);
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: plain.id, reasoning: 'default' });
});

it('loads supported levels for the saved model without paging to its catalogue row', async () => {
  const selectedModel = { id: 'saved/model', name: 'Saved', created: 1, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const mounted = await mountChat({}, [], {
    listGoalModels: async () => ({ ok: true, data: { models: [], total: 500, selectedModel } })
  }, { model: selectedModel.id, reasoning: 'high' });
  const select = mounted.window.document.getElementById('goalReasoning') as HTMLSelectElement;
  select.focus();
  await settle();
  expect(select.value).toBe('high');
  expect(select.selectedOptions[0]?.disabled).toBe(false);
  expect([...select.options].map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  expect(mounted.calls).toHaveLength(0);
});

it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});

it('retains a fresh Goal and first message when rejected sends return to New Chat', async () => {
  const sendInput = vi.fn(async () => ({ ok: false, error: 'test delivery stopped' }));
  const mounted = await mountChat({}, [], { sendInput,
    draftGoalOpening: async () => ({ ok: true, data: { reply: 'Generated opening', model: 'fixture' } })
  });
  const w = mounted.window, doc = w.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('sessionControls')!.hidden).toBe(false);
  (doc.querySelector('[data-mode="goal"]') as HTMLButtonElement).click();
  const objective = doc.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input', { bubbles: true }));
  (doc.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Generated opening', sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Start with the existing code';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(objective.value).toBe('Build and verify the requested feature');
  expect(input.value).toBe('Start with the existing code');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
});

it('gives twenty rapid New Chat sends independent visible local chats before any provider receipt', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row);
    summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, selectedModel: null, usage: {} });
    return ok(row);
  });
  const setInputAutomation = vi.fn(async (id: string, automation: string, loopAfterTurn?: boolean) => {
    const row = rows.find(row => row.id === id); row.automation = automation; if (loopAfterTurn !== undefined) row.loopAfterTurn = loopAfterTurn; return ok(true);
  });
  const setSessionAutomation = vi.fn();
  const mounted = await mountChat({}, [], { sendInput, setInputAutomation, setSessionAutomation,
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  for (let index = 0; index < 20; index++) {
    (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
    field.value = `Independent opening ${index}`;
    doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(index + 1));
    await vi.waitFor(() => expect(doc.querySelector(`.sess.is-sel[data-id="${rows[index]!.sessionId}"]`)).not.toBeNull());
    expect(doc.querySelector(`[data-input-id="${rows[index]!.id}"]`)?.textContent).toContain(rows[index]!.text);
  }
  (doc.querySelector('[data-mode=loop]') as HTMLButtonElement).click(); await settle();
  const loop = doc.getElementById('loopDelivery') as HTMLSelectElement; loop.value = 'after-turn'; loop.dispatchEvent(new w.Event('change')); await settle();
  expect(setInputAutomation).toHaveBeenLastCalledWith(rows[19]!.id, 'loop', true);
  expect(setSessionAutomation).not.toHaveBeenCalled();
  expect(rows[19]).toMatchObject({ automation: 'loop', loopAfterTurn: true });
  expect(rows.slice(0, 19).every(row => row.automation !== 'loop')).toBe(true);
  expect(new Set(rows.map(row => row.sessionId)).size).toBe(20);
  expect(rows.every(row => row.state === 'queued' && row.deliveredAt === undefined)).toBe(true);
  expect(sendInput.mock.calls.every(([request]) => request.sessionId === null)).toBe(true);
});

it('shows the frozen Auto-selected Skill receipt for an accepted ordinary send', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = {
      ...request,
      sessionId: request.id,
      opening: true,
      autoSkills: [{ id: 'code-review', revision: 'a'.repeat(64) }],
      state: 'queued',
      owner: null,
      createdAt: Date.now(),
      conversationId: null
    };
    rows.push(row);
    summaries.push({
      id: row.sessionId,
      title: row.text,
      conversationId: null,
      origin: { kind: 'desktop' },
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      eventCount: 0,
      projectId: null,
      selectedModel: null,
      usage: {}
    });
    return ok(row);
  });
  const mounted = await mountChat({}, [], {
    sendInput,
    listInputs: async () => ok([...rows]),
    runningTools: async () => ok([]),
    listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  field.value = 'Review this source code change for correctness.';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(doc.querySelector('.toast')?.textContent).toContain('Auto-selected Skill: /code-review'));
});

it('does not steal a newer New Chat draft when an older admission response arrives', async () => {
  let release!: (value: any) => void;
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn((request: any) => new Promise(resolve => { release = () => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row); summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, usage: {} });
    resolve(ok(row));
  }; }));
  const mounted = await mountChat({}, [], { sendInput,
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
  field.value = 'Old admission'; doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  (doc.getElementById('newChat') as HTMLButtonElement).click(); field.value = 'Keep this newer draft';
  field.dispatchEvent(new w.Event('input', { bubbles: true })); release(undefined); await settle(); await settle();
  expect(field.value).toBe('Keep this newer draft');
  expect(doc.querySelector('.sess.is-sel')).toBeNull();
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat');
});

it('shows each startup log line once and in order when lines arrive while the log is loading', async () => {
  // Seen on Windows: the Activity page listed "session catalog ready" and "renderer state ready" both before "app started" and again after it. Those lines arrived live while the page was still loading the log, and the loaded log contained them too.
  let live: (entry: any) => void = () => undefined;
  let release!: (reply: any) => void;
  const line = (time: number, message: string) => ({ time, level: 'info', message });
  const mounted = await mountChat({}, [], {
    getLog: () => new Promise(resolve => { release = resolve; }),
    onLogEntry: (fn: any) => { live = fn; return () => undefined; }
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  live(line(2, 'session catalog ready'));
  live(line(3, 'renderer state ready'));
  release({ ok: true, data: [line(1, 'app started'), line(2, 'session catalog ready'), line(3, 'renderer state ready')] });
  await settle(); await settle();
  live(line(4, 'window loaded'));
  // A row shows the line's source and text in separate cells; compare without the spacing.
  const rows = () => [...mounted.window.document.querySelectorAll('#fullFeed > *')].map(row => (row.textContent ?? '').replace(/\s/g, ''));
  await vi.waitFor(() => expect(rows()).toHaveLength(4));
  expect(rows().map(text => ['app started', 'session catalog ready', 'renderer state ready', 'window loaded'].find(m => text.includes(m.replace(/\s/g, '')))))
    .toEqual(['app started', 'session catalog ready', 'renderer state ready', 'window loaded']);
});

it.each(['.project-menu'])('keeps keyboard focus on a project row button (%s) across an activity repaint', async selector => {
  // Seen live on Windows: after picking a project color, focus went back to the color button and the next sidebar repaint dropped it to the page. Only the project heading kept its focus.
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const doc = mounted.window.document;
  const control = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] ${selector}`)!;
  await vi.waitFor(() => expect(control()).not.toBeNull());
  await settle();
  const before = control();
  before.focus();
  expect(doc.activeElement).toBe(before);
  mounted.push(structuredClone(mounted.state));
  await settle();
  expect(control()).not.toBe(before); // the repaint really replaced the row
  expect(doc.activeElement).toBe(control());
});
