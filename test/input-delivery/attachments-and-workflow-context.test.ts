import {
  addProject,
  assignSessionProject,
  browserWake,
  createSession,
  currentCoreInstructions,
  defaultConfig,
  directory,
  finishInstruction,
  fs,
  handlers,
  initSkillsPath,
  input,
  message,
  path,
  post,
  prependUserPrompt,
  randomUUID,
  rebindSession,
  saveConfig,
  userPromptText,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('rejects unsupported unnamespaced provider conversations', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Unnamespaced provider conversation', conversationId });
  const result = await handlers.get('sessions:send')!(null, message(session.id, 'off'));
  expect(result).toMatchObject({ ok: false, error: 'This chat is linked to an unsupported provider session. Start a new chat to continue in NEURAFLOK.' });
});

it('rejects image admission when the session changes during normalization', async () => {
  const attachments = await import('../../backend/domains/sessions/input/attachments/index.js');
  const { default: sharp } = await import('sharp');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Image preparation race', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: Date.now() },
    { kind: 'turn_start', turnId: 'image-race-turn', time: Date.now() }
  ] });
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();
  const file = await attachments.stageInputAttachment({ name: 'race.png', bytes }, new Set());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const normalize = attachments.normalizeInputAttachments;
  const held = vi.spyOn(attachments, 'normalizeInputAttachments').mockImplementation(async files => { await gate; return normalize(files); });
  try {
    const pending = input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', attachments: [file], delivery: 'tool' });
    const rejected = expect(pending).rejects.toThrow('active chat changed');
    await vi.waitFor(() => expect(held).toHaveBeenCalled());
    await rebindSession(session.id, conversationId, randomUUID());
    release(); await rejected;
    expect(await input.listInputs()).toEqual([]);
  } finally { release(); held.mockRestore(); }
});

it('serves staged attachment bytes only to the exact unsent browser input owner', async () => {
  const { stageInputAttachment } = await import('../../backend/domains/sessions/input/attachments/index.js');
  const file = await stageInputAttachment({ text: 'Attachment payload' }, new Set());
  const other = await stageInputAttachment({ text: 'Different input' }, new Set([file.id]));
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', attachments: [file] });
  const request = { id: row.id, owner: 'document-one', conversationId: null, attachmentId: file.id, offset: 0 };
  expect((await post('/input/attachment', request)).status).toBe(409);
  await post('/input/claim', { id: row.id, owner: request.owner, conversationId: null, requiresAuthorization: true });
  expect((await post('/input/attachment', { ...request, owner: 'document-two' })).status).toBe(409);
  expect((await post('/input/attachment', { ...request, attachmentId: other.id })).status).toBe(409);
  expect(Buffer.from((await post('/input/attachment', request)).body.chunk, 'base64').toString()).toBe('Attachment payload');
  expect((await post('/input/claim', { ...request, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/attachment', request)).status).toBe(409);
});

it('revokes a claimed send via IPC, fences pre-send authorization and records a late exact receipt', async () => {
  const row = message(null, 'goal');
  await input.enqueueInput(row as import('../../backend/domains/sessions/input/input.js').InputArgs);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null })).body.input).toBeTruthy();
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await handlers.get('sessions:cancelInput')!(null, { id: row.id })).ok).toBe(true);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(false);
  const conversationId = randomUUID();
  expect((await post('/input/ack', { id: row.id, owner: 'page', conversationId, messageId: 'native-late' })).body.ok).toBe(true);
  expect((await input.listInputs())[0]).toMatchObject({ state: 'cancelled', historyRecorded: true, messageId: 'native-late' });
});

it('bounds an explicit next-tool delivery to four recorded images', async () => {
  const { default: sharp } = await import('sharp');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Four-image injection', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'turn_start', turnId: 'tool-free-turn', time: Date.now() }
  ] });
  const dataUrl = `data:image/webp;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } }).webp().toBuffer()).toString('base64')}`;
  const images = Array.from({ length: 4 }, (_, index) => ({ name: `image-${index}.webp`, dataUrl }));
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', delivery: 'tool', images });
  expect(row).toMatchObject({ state: 'queued', transportIntent: 'tool', toolTurnId: 'tool-free-turn' });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect((await input.offerToolInput(session.id, conversationId, 'first-tool', Date.now())).messages[0]?.images).toHaveLength(4);
  await expect(input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', delivery: 'tool', images: [...images, images[0]!] }))
    .rejects.toThrow();
});

it('freezes selected skills before workflow wrapping and reuses exact delivery after the file is removed', async () => {
  const userData = path.join(directory, 'skill-delivery');
  await initSkillsPath(userData);
  const skillFolder = path.join(userData, 'skills', 'audit');
  await fs.mkdir(skillFolder);
  const skillFile = path.join(skillFolder, 'SKILL.md');
  await fs.writeFile(skillFile, '# Audit\n\nCOMPLETE_SELECTED_SKILL');
  const objective = '/prompt audit\nImplement every original requirement';
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', objective, authoredSource: 'objective',
    text: 'Start implementation', stages: ['Verify every requirement'] });
  const first = await input.claimBrowserInput(row.id, 'skill-owner', null, true);
  expect(first?.text).toContain('COMPLETE_SELECTED_SKILL');
  expect(first?.text).toContain(objective);
  expect(first?.text).toContain('Verify every requirement');
  expect(first!.text.indexOf('# Selected skill')).toBeLessThan(first!.text.indexOf('Original user request:'));
  await fs.unlink(skillFile);
  input.resetInputForTests();
  expect((await input.claimBrowserInput(row.id, 'skill-owner', null, true))?.text).toBe(first?.text);
  expect((await input.listInputs()).find(item => item.id === row.id)?.text).toBe('Start implementation');
  await input.cancelInput(row.id);
  // A new selection must fail explicitly; the old frozen claim alone owns the old bytes.
  const next = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: '/audit New request' });
  await expect(input.claimBrowserInput(next.id, 'new-skill-owner', null, true)).rejects.toThrow('Skill "audit" is unavailable');
});

it.each([false, true])('selects skills from the current composer, never an unrelated saved objective (existing=%s)', async existing => {
  const userData = path.join(directory, 'skill-provenance');
  await initSkillsPath(userData);
  await fs.mkdir(path.join(userData, 'skills/review'), { recursive: true });
  await fs.writeFile(path.join(userData, 'skills/review/SKILL.md'), '# Review\n\nCURRENT_SELECTION');
  const session = existing ? await createSession({ title: 'Skill source', conversationId: randomUUID() }) : null;
  const selected = await input.enqueueInput({ ...message(session?.id ?? null, 'off'), mode: 'auto', text: '/review Current correction', objective: 'Unrelated saved objective' });
  const first = await input.claimBrowserInput(selected.id, 'selection-owner', session?.conversationId ?? null, true);
  expect(first?.text).toContain('CURRENT_SELECTION');
  await input.cancelInput(selected.id);
  const plain = await input.enqueueInput({ ...message(session?.id ?? null, 'off'), mode: 'auto', text: 'Plain correction', objective: '/missing Old objective' });
  const next = await input.claimBrowserInput(plain.id, 'plain-owner', session?.conversationId ?? null, true);
  expect(next?.text).not.toContain('# Selected skill');
  expect(next?.text).toContain('Plain correction');
  await input.cancelInput(plain.id);
});

it('keeps generated slash-leading checkpoints literal until the user explicitly edits one', async () => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true } });
  const session = await createSession({ title: 'Generated checkpoint', conversationId: randomUUID() });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'finish', text: 'First check', stages: ['/missing Generated check'] });
  const checkpoint = (await input.listInputs()).find(item => item.id !== row.id && item.sessionId === session.id)!;
  expect(checkpoint.authoredSource).toBe('none');
  await input.cancelInput(row.id);
  const offered = await input.offerToolInput(session.id, session.conversationId, 'checkpoint-tool', Date.now(), true);
  expect(offered.messages.map(item => item.text).join('\n')).toContain('/missing Generated check');
  const editable = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'finish', text: '/missing Generated check', authoredSource: 'none' });
  expect(await input.editQueuedInput(editable.id, '/missing Human-selected correction')).toBe(true);
  expect((await input.listInputs()).find(item => item.id === editable.id)?.authoredSource).toBe('text');
});

it('freezes the complete current prompt for each new chat and leaves the authored input intact', async () => {
  const config = defaultConfig();
  const standing = 'ä 🐱 Complete standing guidance\n'.repeat(100) + 'FINAL_STANDING_MARKER';
  await saveConfig({ ...config, providerTools: { ...config.providerTools, instructions: standing } });
  const first = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'First request' });
  const canonical = await currentCoreInstructions();
  const claim = await input.claimBrowserInput(first.id, 'exact-document', null, true);
  expect(claim?.text).toBe(prependUserPrompt('First request', canonical));
  expect(claim?.text).toContain(standing);
  expect((await input.listInputs()).find(row => row.id === first.id)?.text).toBe('First request');
  await saveConfig({ ...config, providerTools: { ...config.providerTools, instructions: 'Updated standing guidance' } });
  expect((await input.claimBrowserInput(first.id, 'exact-document', null, true))?.text).toBe(claim?.text);
  await input.cancelInput(first.id);
  const second = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'Second request' });
  const next = await input.claimBrowserInput(second.id, 'next-document', null, true);
  expect(next?.text).toBe(prependUserPrompt('Second request', await currentCoreInstructions()));
  expect(userPromptText(next!.text)).toBe('Second request');
});

it.each(['off', 'goal', 'loop'] as const)('does not repeat setup in an existing chat with %s enabled', async automation => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Existing executor', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, automation), mode: 'auto', text: 'Continue the original work' });
  const claim = await input.claimBrowserInput(row.id, 'followup-page', conversationId, true);
  expect(claim?.text).toBe('Continue the original work');
  input.resetInputForTests();
  expect((await input.claimBrowserInput(row.id, 'followup-page', conversationId, true))?.text).toBe(claim?.text);
});

it('delivers only the selected project AGENTS.md, freezes claims across restart, and budgets the Astra appendix before cutting', async () => {
  const folder = path.join(directory, 'project-' + randomUUID());
  await fs.mkdir(folder);
  const file = path.join(folder, 'AGENTS.md');
  await fs.writeFile(file, 'PROJECT_HEAD\n' + 'project instructions\n'.repeat(30000) + '\nPROJECT_TAIL');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: folder }], ui: { ...config.ui, finishTool: true } });
  const project = await addProject(folder);
  const request = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', projectId: project.id,
    model: 'gpt-6-pro', reasoningEffort: 'pro' });
  const claim = await input.claimBrowserInput(request.id, 'project-document', null, true);
  expect(claim!.text.length).toBeLessThanOrEqual(96000);
  expect(claim!.text).toContain(await currentCoreInstructions());
  expect(claim!.text).toContain('PROJECT_HEAD');
  expect(claim!.text).not.toContain('PROJECT_TAIL');
  expect(claim!.text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(claim!.text)).toBe(request.text + '\n\n' + finishInstruction());
  expect((await input.listInputs()).find(row => row.id === request.id)!.text).toBe(request.text);
  await fs.writeFile(file, 'PROJECT_CHANGED');
  input.resetInputForTests();
  expect((await input.claimBrowserInput(request.id, 'project-document', null, true))!.text).toBe(claim!.text);
  await input.cancelInput(request.id);
  const normal = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  const ordinary = await input.claimBrowserInput(normal.id, 'ordinary-document', null);
  expect(ordinary!.text).not.toMatch(/PROJECT_HEAD|PROJECT_CHANGED|# AGENTS.md instructions for/);
  await input.cancelInput(normal.id);
  const session = await createSession({ title: 'Project follow-up', conversationId: 'project-followup-chat' });
  await assignSessionProject(session.id, project.id);
  const followup = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  const tool = await input.offerToolInput(session.id, session.conversationId, 'project-tool-call', Date.now());
  expect(tool.messages).toHaveLength(1);
  expect(tool.messages[0]!.text).not.toMatch(/PROJECT_CHANGED|NEURAFLOK_MESSAGE_V1|NEURAFLOK_CONTEXT/);
  expect((await input.listInputs()).find(row => row.id === followup.id)!.deliveryText).toBe(followup.text);
});

it.each(['finish', 'after-turn'] as const)('wakes browser delivery after a committed final makes %s input eligible', async mode => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Final-boundary wake', conversationId });
  await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'wake-turn', time: Date.now() }] });
  const queued = await input.enqueueInput({ ...message(session.id, 'off'), mode });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  const snapshots: ReturnType<typeof input.pendingBrowserInputs>[] = [];
  const wake = vi.spyOn(browserWake, 'wakeBrowserWork').mockImplementation(() => { snapshots.push(input.pendingBrowserInputs()); });
  try {
    const complete = await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'wake-turn', outcome: 'completed', time: Date.now() + 1 }] });
    expect(complete.status).toBe(200);
    expect(wake).toHaveBeenCalled();
    expect((await Promise.all(snapshots)).some(rows => rows.some(row => row.id === queued.id))).toBe(true);
    // The notification only prompts a read: it must not consume or claim input.
    expect((await input.listInputs()).find(row => row.id === queued.id)?.state).toBe('queued');
    const claim = await input.claimBrowserInput(queued.id, 'checkpoint-page', conversationId, true);
    expect(claim?.text).toBe(queued.text);
  } finally { wake.mockRestore(); }
});
