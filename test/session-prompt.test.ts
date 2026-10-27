import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../backend/infrastructure/settings/config.js';
import { initDurableStore, resetDurableForTests } from '../backend/persistence/durable.js';
import { addProject, assignSessionProject } from '../backend/domains/workspace/projects.js';
import { createSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../backend/domains/sessions/history/store.js';
import { fitSessionPrompt, prepareProviderSessionPrompt, prepareProviderSkillFollowup, prepareSessionPrompt } from '../backend/domains/sessions/input/prompt.js';
import {
  formatProviderConversationRecap,
  buildProviderReconnectContext,
  buildProviderProjectContext,
  buildGeneralChatContext,
  isNewProviderChat,
  looksLikeContinueRequest,
  needsWorkPlan,
  looksLikeStaleCompletion,
  looksLikeProjectStatusRecap,
  parseWorkPlan,
  formatPlanOnlyPrompt,
  formatExecuteStepPrompt,
  prepareLocalProviderPrompt,
  resetLocalProviderHydrationForTests
} from '../backend/domains/sessions/input/provider-context.js';
import { MAX_PROVIDER_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../contracts/messaging/provider-message-envelope.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
/** Provider composers escape internal framing on readback, so the parser restores Markdown punctuation before checking the declared instruction length. */
it('reads a frame the page escaped, and keeps an authored backslash literal', () => {
  const instructions = 'You are a coding agent.\nKeep task work there.';
  const framed = prependUserPrompt('write me a plugin\n\nsecond line', instructions);
  expect(framed).toContain('[[NEURAFLOK_MESSAGE_V1:');
  expect(userPromptText(framed)).toBe('write me a plugin\n\nsecond line');

  // Exactly what the composer does: every ASCII punctuation mark and every newline.
  const escaped = framed.replace(/([!-/:-@[-`{-~])/g, '\\$1').replace(/\n/g, '\\\n');
  expect(escaped).toContain('\\[\\[NEURAFLOK\\_MESSAGE\\_V1\\:');
  expect(userPromptText(escaped)).toBe('write me a plugin\n\nsecond line');

  // The tolerant read is a second attempt, never the first: a prompt that really contains a backslash keeps it, because the exact frame around it parses.
  const literal = prependUserPrompt('use \\[ in the regex', instructions);
  expect(userPromptText(literal)).toBe('use \\[ in the regex');

  // And text that is not a frame at all stays unrecognised, escaped or not.
  expect(userPromptText('\\[\\[NEURAFLOK\\_CONTEXT\\:9\\]\\]\\\nnot a frame')).toBeNull();
});

it('reads stored context formats while generating only the current product format', () => {
  const oldFrame = '[[NEURAL_JAM_CONTEXT:11]]\nold context\n[[/NEURAL_JAM_CONTEXT]]\n\nTask';
  const currentFrame = prependUserPrompt(oldFrame, 'new context');
  expect(currentFrame).toContain('[[NEURAFLOK_MESSAGE_V1:');
  expect(currentFrame).not.toContain('[[NEURAL_JAM_CONTEXT:');
  expect(userPromptText(currentFrame)).toBe('Task');
  expect(userPromptText('[[NEURAFLOK_CONTEXT:11]]\nold context\n[[/NEURAFLOK_CONTEXT]]\n\nTask')).toBe('Task');
});

it('preserves a previous continuation identity while wrapping stored prompt context', () => {
  const previousPrompt = '[[CLF-RESUME:abcdefghijklmnop]]\n\nContinue the saved task.';
  const framed = prependUserPrompt(previousPrompt, 'Current product instructions.');
  expect(framed).toMatch(/^\[\[CLF-RESUME:abcdefghijklmnop\]\]\n\n\[\[NEURAFLOK_MESSAGE_V1:/);
  expect(userPromptText(framed)).toBe(previousPrompt);
});

it('reduces AGENTS to 5000 before shortening every selected skill under char and byte limits', () => {
  const agents = { directory: '/work', text: 'A'.repeat(30_000), truncated: false };
  const skills = [{ id: 'first', text: 'FIRST\n' + '🐱漢字'.repeat(20_000) }, { id: 'second', text: 'SECOND\n' + 'z'.repeat(60_000) }];
  const task = 'Exact user request';
  for (const budget of [{ maxChars: 25_000, maxBytes: Infinity }, { maxChars: 96_000, maxBytes: 30_000 }]) {
    const result = fitSessionPrompt(task, 'CORE_UNCHANGED', agents, budget, skills);
    expect(result).toContain('CORE_UNCHANGED');
    expect(userPromptText(result)).toBe(task);
    expect(result).toContain('A'.repeat(5000));
    expect(result).not.toContain('A'.repeat(5001));
    expect(result).toContain('FIRST'); expect(result).toContain('SECOND');
    expect(result).toContain('Read /skills/first/SKILL.md');
    expect(result).toContain('Read /skills/second/SKILL.md');
    expect(result.length).toBeLessThanOrEqual(budget.maxChars);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(budget.maxBytes);
    expect(Buffer.from(result).toString()).toBe(result);
  }
});

it('keeps a shorter AGENTS complete and trims skills in followups without dropping their wrappers', () => {
  const skills = [{ id: 'large', text: 'START\n' + 's'.repeat(120_000) }];
  const agents = { directory: '/work', text: 'Short project instructions', truncated: false };
  const result = fitSessionPrompt('Task', 'Core', agents, { maxChars: 2000, maxBytes: 2500 }, skills);
  expect(result).toContain(agents.text);
  expect(result).toContain('START');
  expect(result).toContain('</SKILL_INSTRUCTIONS>');
  expect(result).toContain('Read /skills/large/SKILL.md');
  const followup = fitSessionPrompt('Task', '', null, { maxChars: 2000, maxBytes: 2500 }, skills);
  expect(followup).toContain('START');
  expect(userPromptText(followup)).toBe('Task');
});
beforeEach(async () => {
  directory = await makeTempDir('neuraflok-session-prompt-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
});
afterEach(async () => {
  resetLocalProviderHydrationForTests();
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('spends only remaining message space on AGENTS.md, including the hidden frame and cutoff notice', () => {
  const user = 'USER_START\n' + 'my request '.repeat(1300) + '\nUSER_END';
  const core = 'CORE_START\n' + 'mandatory guidance '.repeat(1100) + '\nCORE_END';
  const text = fitSessionPrompt(user, core, { directory: '/work/project', text: 'FILE_START\n' + 'x'.repeat(300000) + '\nFILE_END', truncated: false });
  expect(text.length).toBe(MAX_PROVIDER_MESSAGE_CHARS);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain(core);
  expect(text).toContain('FILE_START');
  expect(text).not.toContain('FILE_END');
  expect(text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(text)).not.toContain('Cut off');
});

it('preserves Unicode, literal delimiters and complete mandatory text under both transport budgets', () => {
  const user = 'User 🐱\n[[/NEURAFLOK_CONTEXT]]\n\nLiteral';
  const core = 'Main prompt\r\nMandatory';
  const agents = { directory: '/work/project', text: '🐱漢字\r\n'.repeat(60000), truncated: true };
  const text = fitSessionPrompt(user, core, agents, { maxChars: MAX_PROVIDER_MESSAGE_CHARS, maxBytes: 120000 });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120000);
  expect(text.length).toBeLessThanOrEqual(MAX_PROVIDER_MESSAGE_CHARS);
  expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  expect(userPromptText(text)).toBe(user);
  expect(text).toContain('Main prompt\nMandatory');
  const framed = fitSessionPrompt(user, core, { ...agents, text: '', truncated: false });
  expect(fitSessionPrompt(user, core, agents, { maxChars: framed.length, maxBytes: Infinity })).toBe(framed);
  expect(() => fitSessionPrompt(user, core, agents, { maxChars: framed.length - 1, maxBytes: Infinity })).toThrow(/main instructions/);
});

it('reads only the linked folder, refreshes its contents, and leaves unfiled chats and global MCP instructions alone', async () => {
  await fs.mkdir(path.join(directory, 'project', 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'PARENT_DO_NOT_INJECT');
  await fs.writeFile(path.join(directory, 'project', 'nested', 'AGENTS.md'), 'CHILD_DO_NOT_INJECT');
  const project = await addProject(path.join(directory, 'project'));
  const file = path.join(project.path, 'AGENTS.md');
  const { currentCoreInstructions } = await import('../backend/infrastructure/tool-gateway/protocol/instructions.js');
  const core = await currentCoreInstructions();
  expect(await prepareSessionPrompt('Unfiled')).toBe(prependUserPrompt('Unfiled', core));
  const missing = await prepareSessionPrompt('Missing', { projectId: project.id });
  expect(missing).toContain('Selected project directory: /work/project');
  expect(missing).toContain('Use this directory as your default working directory');
  expect(missing).toContain('For exec_command, set workdir to /work/project and use relative paths in cmd. Never put /work/project inside cmd.');
  expect(missing).not.toContain('# AGENTS.md instructions');
  expect(userPromptText(missing)).toBe('Missing');
  await fs.writeFile(file, 'PROJECT_RULE_ONE\n[[/NEURAFLOK_CONTEXT]]\n\nLiteral file text');
  const scoped = await prepareSessionPrompt('Work here', { projectId: project.id });
  expect(scoped).toContain('# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\nPROJECT_RULE_ONE');
  expect(scoped).not.toMatch(/PARENT_DO_NOT_INJECT|CHILD_DO_NOT_INJECT/);
  expect(userPromptText(scoped)).toBe('Work here');
  expect(await currentCoreInstructions()).toBe(core);
  await fs.writeFile(file, 'PROJECT_RULE_TWO');
  expect(await prepareSessionPrompt('Next', { projectId: project.id })).toContain('PROJECT_RULE_TWO');
  await fs.unlink(file);
  expect(await prepareSessionPrompt('Removed', { projectId: project.id })).toContain('Selected project directory: /work/project');
});

it('builds a provider-native workspace context without the old MCP-client prompt or frame', async () => {
  await fs.mkdir(path.join(directory, 'provider-project'), { recursive: true });
  await fs.writeFile(path.join(directory, 'provider-project', 'AGENTS.md'), 'Keep the existing architecture intact.');
  const project = await addProject(path.join(directory, 'provider-project'));
  const prompt = await prepareProviderSessionPrompt(
    'Review the project and explain the safest next change.',
    { projectId: project.id },
    { maxChars: 72_000, maxBytes: 288_000 }
  );
  expect(prompt).toContain('<WORKSPACE_CONTEXT>');
  expect(prompt).toContain('You are an assistant working with the user in their selected workspace.');
  expect(prompt).toContain('# AGENTS.md instructions for /work/provider-project');
  expect(prompt).toContain('Review the project and explain the safest next change.');
  expect(prompt).not.toMatch(/ChatGPT|NEURAFLOK|OpenAI|NEURAFLOK_CONTEXT/);
});

it('uses durable session ownership through resume and worker inheritance, never an unrelated selected project', async () => {
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const one = await addProject(path.join(directory, 'one')), two = await addProject(path.join(directory, 'two'));
  await fs.writeFile(path.join(one.path, 'AGENTS.md'), 'PROJECT_ONE_ONLY');
  await fs.writeFile(path.join(two.path, 'AGENTS.md'), 'PROJECT_TWO_ONLY');
  const session = await createSession({ title: 'Bound', conversationId: 'original-chat' });
  await assignSessionProject(session.id, one.id);
  await rebindSession(session.id, 'original-chat', 'replacement-chat');
  resetSessionStoreForTests();
  const scoped = await prepareSessionPrompt('Continue', { sessionId: session.id, projectId: two.id });
  expect(scoped).toContain('PROJECT_ONE_ONLY'); expect(scoped).not.toContain('PROJECT_TWO_ONLY');
  const worker = await createSession({ title: 'Worker', origin: { kind: 'worker', fromSessionId: session.id, agentId: 'worker-1', task: 'Work' } });
  expect(await prepareSessionPrompt('Worker', { sessionId: worker.id })).toContain('PROJECT_ONE_ONLY');
  const unfiled = await createSession({ title: 'Unfiled' });
  expect(await prepareSessionPrompt('Ordinary chat', { sessionId: unfiled.id, projectId: two.id })).not.toContain('PROJECT_TWO_ONLY');
});

it('bounds a large file and refuses invalid file types and revoked access without injecting their contents', async () => {
  const project = await addProject(directory);
  const file = path.join(directory, 'AGENTS.md');
  await fs.writeFile(file, 'LARGE_HEAD\n' + 'x'.repeat(2_000_000) + 'LARGE_TAIL');
  const text = await prepareSessionPrompt('User message', { projectId: project.id });
  expect(text.length).toBeLessThanOrEqual(MAX_PROVIDER_MESSAGE_CHARS);
  expect(text).toContain('LARGE_HEAD'); expect(text).not.toContain('LARGE_TAIL');
  await fs.writeFile(file, Buffer.from([0xff, 0x00]));
  await expect(prepareSessionPrompt('Binary', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.unlink(file); await fs.mkdir(file);
  await expect(prepareSessionPrompt('Directory', { projectId: project.id })).rejects.toThrow(/AGENTS.md safely/);
  await fs.rmdir(file); await fs.writeFile(file, 'PRIVATE_RULE');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'work', path: directory }], capabilities: { ...config.capabilities, read: false } });
  const noRead = await prepareSessionPrompt('No read', { projectId: project.id });
  expect(noRead).not.toContain('PRIVATE_RULE');
  expect(noRead).toContain('Selected project directory: /work');
  await saveConfig(defaultConfig());
  await expect(prepareSessionPrompt('Revoked', { projectId: project.id })).rejects.toThrow();
});

it('tells the provider to reply in the configured interface language', async () => {
  await fs.mkdir(path.join(directory, 'language-project'), { recursive: true });
  const project = await addProject(path.join(directory, 'language-project'));
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }], ui: { ...defaultConfig().ui, language: 'es' } });
  const prompt = await prepareProviderSessionPrompt('Explica el siguiente cambio.', { projectId: project.id });
  expect(prompt).toContain('Reply in Spanish');
  expect(prompt).toContain('Explica el siguiente cambio.');
  expect(prompt).not.toMatch(/ChatGPT|NEURAFLOK|OpenAI|NEURAFLOK_CONTEXT/);
});

it('keeps language and project directory on later provider turns without repeating AGENTS.md', async () => {
  await fs.mkdir(path.join(directory, 'follow-project'), { recursive: true });
  await fs.writeFile(path.join(directory, 'follow-project', 'AGENTS.md'), 'DO_NOT_REPEAT_ON_FOLLOWUP');
  const project = await addProject(path.join(directory, 'follow-project'));
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }], ui: { ...defaultConfig().ui, language: 'es' } });
  const opening = await prepareProviderSessionPrompt('Escribe un README', { projectId: project.id });
  expect(opening).toContain('Reply in Spanish');
  expect(opening).toContain('DO_NOT_REPEAT_ON_FOLLOWUP');
  const followup = await prepareProviderSkillFollowup('Continúa con el README', 'Continúa con el README', undefined, { projectId: project.id });
  expect(followup).toContain('Reply in Spanish');
  expect(followup).toContain('Selected project directory: /work/follow-project');
  expect(followup).toContain('For exec_command, set workdir to /work/follow-project and use relative paths in cmd. Never put /work/follow-project inside cmd.');
  expect(followup).not.toContain('DO_NOT_REPEAT_ON_FOLLOWUP');
  expect(followup).toContain('Continúa con el README');
  expect(followup).not.toMatch(/ChatGPT|NEURAFLOK|OpenAI|NEURAFLOK_CONTEXT/);
});

it('treats bare continue messages as a request to restore project context', () => {
  expect(looksLikeContinueRequest('CONTINUA')).toBe(true);
  expect(looksLikeContinueRequest('continúa')).toBe(true);
  expect(looksLikeContinueRequest('Continue please')).toBe(true);
  expect(looksLikeContinueRequest('Continúa con el README')).toBe(false);
  expect(looksLikeContinueRequest('Añade tests unitarios')).toBe(false);
});

it('injects AGENTS.md and conversation recap when the user only asks to continue', async () => {
  await fs.mkdir(path.join(directory, 'resume-project'), { recursive: true });
  await fs.writeFile(path.join(directory, 'resume-project', 'AGENTS.md'), 'KEEP_THE_EXISTING_TREE_API');
  const project = await addProject(path.join(directory, 'resume-project'));
  const recap = formatProviderConversationRecap([
    { role: 'system', content: 'guide' },
    { role: 'user', content: 'Initialize this NEURAFLOK conversation using the instructions below.' },
    { role: 'assistant', content: 'NEURAFLOK_READY' },
    { role: 'user', content: 'Implementa el arbol binario' },
    { role: 'assistant', content: 'Voy a leer AGENTS.md y el código actual.' }
  ]);
  expect(recap).toContain('Implementa el arbol binario');
  expect(recap).toContain('CONVERSATION_SO_FAR');
  expect(recap).not.toContain('NEURAFLOK_READY');
  const session = await createSession({ title: 'Continue' });
  await assignSessionProject(session.id, project.id);
  const prompt = await prepareLocalProviderPrompt(
    { text: 'CONTINUA', projectId: project.id } as never,
    session.id,
    false,
    { recap, hydrateWorkspace: true }
  );
  expect(prompt).toContain('KEEP_THE_EXISTING_TREE_API');
  expect(prompt).toContain('Implementa el arbol binario');
  expect(prompt).toContain('Do not start an unrelated task');
});

it('builds a continuation markdown pack with project tree, edits, and usable conversation', async () => {
  await fs.mkdir(path.join(directory, 'shop', 'src'), { recursive: true });
  await fs.writeFile(path.join(directory, 'shop', 'AGENTS.md'), 'KEEP_SHOP');
  await fs.writeFile(path.join(directory, 'shop', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(directory, 'shop', 'src', 'app.js'), 'ok');
  const project = await addProject(path.join(directory, 'shop'));
  const session = await createSession({ title: 'Shop' });
  await assignSessionProject(session.id, project.id);
  const pack = await buildProviderReconnectContext(session.id, [
    { role: 'system', content: 'guide' },
    { role: 'user', content: 'Implementa la librería' },
    { role: 'assistant', content: 'NEURAFLOK_READY' },
    { role: 'tool', content: 'Success. Updated the following files:\nA /work/shop/index.html' },
    { role: 'assistant', content: 'This DeepSeek session has no verified browser tab. Start a new chat to reconnect it safely.' },
    { role: 'assistant', content: '<neuraflok-tool fence> {"name":"read","arguments":{"paths":["/work/shop/index.html"]}} </neuraflok-tool>' },
    { role: 'assistant', content: 'La app está lista en index.html.' },
    { role: 'user', content: 'Qué animaciones podemos agregar' }
  ], 'Reply in Spanish. Use complete neuraflok-tool fences.');
  expect(pack).toContain('Continuation of this NEURAFLOK session');
  expect(pack).toContain('index.html');
  expect(pack).toContain('app.js');
  expect(pack).toContain('Added /work/shop/index.html');
  expect(pack).toContain('Implementa la librería');
  expect(pack).toContain('Qué animaciones podemos agregar');
  expect(pack).toContain('La app está lista');
  expect(pack).toContain('How to reply');
  expect(pack).toContain('Where this session left off');
  expect(pack).not.toContain('NEURAFLOK_READY');
  expect(pack).not.toContain('no verified browser tab');
});

it('passes only the project tree on a new chat and the full session pack on an old chat', async () => {
  await fs.mkdir(path.join(directory, 'desk', 'src'), { recursive: true });
  await fs.writeFile(path.join(directory, 'desk', 'AGENTS.md'), 'KEEP_DESK');
  await fs.writeFile(path.join(directory, 'desk', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(directory, 'desk', 'src', 'app.js'), 'ok');
  const project = await addProject(path.join(directory, 'desk'));
  const session = await createSession({ title: 'Desk' });
  await assignSessionProject(session.id, project.id);
  const thread = [
    { role: 'user', content: 'Implementa el panel' },
    { role: 'tool', content: 'Success. Updated the following files:\nA /work/desk/index.html' },
    { role: 'assistant', content: 'El panel ya lista los libros.' },
    { role: 'user', content: 'CONTINUA' }
  ];
  const fresh = await buildProviderProjectContext(session.id, thread, { newChat: true });
  expect(fresh).toContain('Project structure');
  expect(fresh).toContain('How to reply');
  expect(fresh).toContain('index.html');
  expect(fresh).toContain('app.js');
  expect(fresh).not.toContain('Implementa el panel');
  expect(fresh).not.toContain('Added /work/desk/index.html');
  expect(fresh).not.toContain('CONTINUA');
  expect(fresh).not.toContain('Continuation of this NEURAFLOK session');
  expect(fresh).not.toContain('Where this session left off');
  const old = await buildProviderProjectContext(session.id, thread, { newChat: false, replyGuide: 'Reply in Spanish.' });
  expect(old).toContain('Continuation of this NEURAFLOK session');
  expect(old).toContain('index.html');
  expect(old).toContain('Implementa el panel');
  expect(old).toContain('Added /work/desk/index.html');
  expect(old).toContain('El panel ya lista');
  expect(old).toContain('Where this session left off');
  expect(old).not.toContain('CONTINUA');
});

it('treats a bootstrap-only thread as a new chat, not an old recap', () => {
  expect(isNewProviderChat([{ role: 'system', content: 'guide' }])).toBe(true);
  expect(isNewProviderChat([
    { role: 'system', content: 'guide' },
    { role: 'user', content: 'Initialize this NEURAFLOK conversation using the instructions below.' },
    { role: 'assistant', content: 'NEURAFLOK_READY' }
  ])).toBe(true);
  expect(isNewProviderChat([
    { role: 'system', content: 'guide' },
    { role: 'user', content: 'Implementa el panel' },
    { role: 'assistant', content: 'Listo.' }
  ])).toBe(false);
  expect(isNewProviderChat([{ role: 'user', content: 'Hola' }], true)).toBe(true);
});

it('keeps general chats as conversation recap without a project tree', async () => {
  const session = await createSession({ title: 'General' });
  const thread = [
    { role: 'user', content: 'Hola necesito ayuda' },
    { role: 'assistant', content: 'Claro, dime.' },
    { role: 'user', content: 'Explícame esto' }
  ];
  expect(await buildGeneralChatContext(session.id, thread, { newChat: true })).toBe('');
  const old = await buildGeneralChatContext(session.id, thread, { newChat: false });
  expect(old).toContain('Conversation recap');
  expect(old).toContain('Hola necesito ayuda');
  expect(old).toContain('Claro, dime.');
  expect(old).toContain('This is not a coding project');
  expect(old).not.toContain('Project structure');
  expect(old).not.toContain('apply_patch');
  expect(old).not.toContain('Approved roots');
  const prompt = await prepareLocalProviderPrompt(
    { text: 'Explícame esto', projectId: null } as never,
    session.id,
    false,
    { recap: old, conversationOnly: true }
  );
  expect(prompt).toContain('Explícame esto');
  expect(prompt).toContain('Hola necesito ayuda');
  expect(prompt).not.toContain('WORKSPACE_CONTEXT');
  expect(prompt).not.toContain('Execute the user task');
});

it('treats a new request on an old chat as the current task even if the recap said the work was done', async () => {
  await fs.mkdir(path.join(directory, 'libros'), { recursive: true });
  await fs.writeFile(path.join(directory, 'libros', 'index.html'), '<html></html>');
  const project = await addProject(path.join(directory, 'libros'));
  const session = await createSession({ title: 'Libros' });
  await assignSessionProject(session.id, project.id);
  const task = 'Puedes cambiar todo y usar Next.js, y Anime.js para una animación de carga al entrar';
  const pack = await buildProviderProjectContext(session.id, [
    { role: 'user', content: 'Implementa la librería' },
    { role: 'assistant', content: 'El proyecto está completo y verificado; no quedan tareas pendientes.' }
  ], { newChat: false, continueOnly: false, currentTask: task });
  expect(pack).toContain('Current user request');
  expect(pack).toContain('Next.js');
  expect(pack).toContain('Anime.js');
  expect(pack).toContain('The latest user message is the current task');
  expect(pack).toContain('even if a previous recap said the project was complete');
  expect(pack).not.toContain('Do not start an unrelated task');
  expect(pack).not.toContain('Do not restart the project from scratch');
  expect(pack).not.toContain('no quedan tareas pendientes');
});

it('plans new work and ignores a stale complete banner', () => {
  expect(needsWorkPlan('CONTINUA')).toBe(false);
  expect(needsWorkPlan('Hola')).toBe(false);
  expect(needsWorkPlan('Puedes cambiar todo y usar Next.js y Anime.js para una animación de carga')).toBe(true);
  expect(looksLikeStaleCompletion('El proyecto está completo y verificado; no quedan tareas pendientes.')).toBe(true);
  expect(looksLikeStaleCompletion('Paso 1: creé el scaffold de Next.js.')).toBe(false);
  expect(looksLikeProjectStatusRecap('Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:\n\nLógica (core.js)\n\nnpm run dev y abre http://localhost:3000.')).toBe(true);
  expect(looksLikeProjectStatusRecap('Hola, dime en qué te ayudo.')).toBe(false);
  expect(parseWorkPlan('1. Crear app Next.js\n2. Portar el catálogo\n3. Añadir Anime.js al entrar')).toEqual([
    'Crear app Next.js',
    'Portar el catálogo',
    'Añadir Anime.js al entrar'
  ]);
  expect(formatPlanOnlyPrompt('Usa Next.js y Anime.js')).toContain('PLAN_ONLY');
  expect(formatPlanOnlyPrompt('Usa Next.js y Anime.js')).toContain('must be ignored');
  expect(formatExecuteStepPrompt({
    task: 'Usa Next.js y Anime.js',
    steps: ['Scaffold Next.js', 'Portar catálogo', 'Animación Anime.js'],
    index: 0
  })).toContain('Do ONLY step 1 of 3: Scaffold Next.js');
});
