import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../backend/infrastructure/settings/config.js';
import { initDurableStore, resetDurableForTests } from '../backend/persistence/durable.js';
import { addProject, assignSessionProject } from '../backend/domains/workspace/projects.js';
import { createSession, initSessionStore, rebindSession, resetSessionStoreForTests } from '../backend/domains/sessions/history/store.js';
import { fitSessionPrompt, prepareProviderSessionPrompt, prepareProviderSkillFollowup, prepareSessionPrompt } from '../backend/domains/sessions/input/prompt.js';
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
  expect(followup).not.toContain('DO_NOT_REPEAT_ON_FOLLOWUP');
  expect(followup).toContain('Continúa con el README');
  expect(followup).not.toMatch(/ChatGPT|NEURAFLOK|OpenAI|NEURAFLOK_CONTEXT/);
});
