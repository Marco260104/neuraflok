import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../contracts/types.js';

let dom: JSDOM;

function setupDom(): void {
  dom = new JSDOM('<input id="workerModel"><select id="workerReasoning"><option value="">Automatic</option><option value="high">High</option><option value="medium">Medium</option></select>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
}

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('formats the provider model observed in a conversation', async () => {
  setupDom();
  const { chatModelName } = await import('../frontend/features/chat/chat-models.js');

  expect(chatModelName('deepseek-v3.2', 'high')).toContain('deepseek-v3.2');
  expect(chatModelName('qwen3-coder', undefined)).toBe('qwen3-coder');
});

it('keeps model observations scoped to the selected session', async () => {
  setupDom();
  const { applyComposerSessionModel, observedComposerModel } = await import('../frontend/features/chat/chat-models.js');
  applyComposerSessionModel('session-a:1', { model: 'deepseek-v3.2', reasoningEffort: 'high', observedAt: 10 });
  expect(observedComposerModel()).toEqual({ model: 'deepseek-v3.2', reasoningEffort: 'high' });

  applyComposerSessionModel('session-a:1', { model: 'stale-model', reasoningEffort: 'low', observedAt: 9 });
  expect(observedComposerModel()).toEqual({ model: 'deepseek-v3.2', reasoningEffort: 'high' });

  applyComposerSessionModel('session-b:2', null);
  expect(observedComposerModel()).toBeNull();
});

it('saves worker model settings without a provider account catalog', async () => {
  setupDom();
  const { applyChatModels } = await import('../frontend/features/chat/chat-models.js');
  const config = {
    multiAgent: { defaultModel: 'qwen3-coder', defaultReasoning: 'high' }
  } as Config;
  applyChatModels(config);

  const model = dom.window.document.getElementById('workerModel') as HTMLInputElement;
  const reasoning = dom.window.document.getElementById('workerReasoning') as HTMLSelectElement;
  expect(model.value).toBe('qwen3-coder');
  expect(reasoning.value).toBe('high');

  const previous = config;
  model.value = 'local-edit';
  model.focus();
  applyChatModels({
    multiAgent: { defaultModel: 'deepseek-chat', defaultReasoning: 'medium' }
  } as Config, previous);
  expect(model.value).toBe('local-edit');
  expect(reasoning.value).toBe('medium');

  reasoning.value = 'high';
  reasoning.focus();
  applyChatModels({
    multiAgent: { defaultModel: 'qwen3-coder', defaultReasoning: 'medium' }
  } as Config, {
    multiAgent: { defaultModel: 'deepseek-chat', defaultReasoning: 'medium' }
  } as Config);
  expect(reasoning.value).toBe('high');
});
