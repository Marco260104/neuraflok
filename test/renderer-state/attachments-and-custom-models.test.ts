import { mountChat } from './context.js';
import { DEFAULT_GOAL_MODEL } from "../../contracts/automation/goal-settings.js";
import { expect, it, vi } from 'vitest';

it('attaches pasted screenshot files with previews while preserving ordinary text paste', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'screenshot.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' }] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, input = w.document.getElementById('settingsFind') as HTMLInputElement;
  input.focus();
  const file = new w.File(['image'], 'screenshot.png', { type: '' });
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  input.dispatchEvent(paste);
  await vi.waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
  const text = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect(w.document.activeElement).toBe(input);
  const overflow = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(overflow, 'clipboardData', { value: { files: Array(51).fill(file) } });
  input.dispatchEvent(overflow);
  expect(overflow.defaultPrevented).toBe(true);
  expect(dropFiles).toHaveBeenCalledTimes(1);
});

it('preserves the selected OpenRouter model through an unchanged custom-provider round trip', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const original = 'z-ai/glm-5.3-flash';
  mounted.state.config.goal = { ...mounted.state.config.goal, model: original };
  mounted.push(mounted.state);
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  // Repainting custom settings must not replace the hidden OpenRouter picker's model.
  mounted.push({ ...mounted.state, hasCustomProviderKey: false });
  provider.value = 'openrouter'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].providers.api).toMatchObject({ kind: 'openrouter' });
  expect(mounted.calls[1].goal).toMatchObject({ model: original });
  expect(w.document.getElementById('goalModelName')!.textContent).toBe(original);
});

it('uses the OpenRouter default when opened directly on an unrelated custom deployment', async () => {
  const mounted = await mountChat({}, [], {}, { model: 'llama3.1' }, { kind: 'custom', baseUrl: 'http://localhost:8000/v1' });
  const provider = mounted.window.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'openrouter';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].providers.api).toMatchObject({ kind: 'openrouter' });
  expect(mounted.calls[0].goal).toMatchObject({ model: DEFAULT_GOAL_MODEL });
});

it('saves a custom deployment id and returns to the known OpenRouter model', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].providers.api.kind).toBe('custom');
  expect(w.document.getElementById('goalCustomPanel')?.hidden).toBe(false);
  const model = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  model.value = 'llama3.1';
  model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal.model).toBe('llama3.1');
  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].providers.api).toMatchObject({ kind: 'openrouter' });
  expect(mounted.calls[2].goal).toMatchObject({ model: 'deepseek/deepseek-v4-flash' });
});

it('loads and saves a custom API name, routes, and authentication settings', async () => {
  const mounted = await mountChat({}, [], {}, { model: 'team-model' }, {
    kind: 'custom',
    baseUrl: 'https://api.example.test/v1',
    protocol: 'anthropic-messages',
    name: 'Team gateway',
    chatPath: 'tenant/chat/completions',
    modelsPath: 'tenant/models',
    authHeader: 'x-api-key',
    authPrefix: ''
  });
  const w = mounted.window;
  expect((w.document.getElementById('goalCustomName') as HTMLInputElement).value).toBe('Team gateway');
  expect((w.document.getElementById('goalCustomProtocol') as HTMLSelectElement).value).toBe('anthropic-messages');
  expect((w.document.getElementById('goalCustomChatPath') as HTMLInputElement).value).toBe('tenant/chat/completions');
  expect((w.document.getElementById('goalCustomModelsPath') as HTMLInputElement).value).toBe('tenant/models');
  expect((w.document.getElementById('goalCustomAuthHeader') as HTMLInputElement).value).toBe('x-api-key');
  expect((w.document.getElementById('goalCustomAuthPrefix') as HTMLInputElement).value).toBe('');

  const name = w.document.getElementById('goalCustomName') as HTMLInputElement;
  name.value = 'Production gateway';
  name.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].providers.api).toMatchObject({
    kind: 'custom',
    protocol: 'anthropic-messages',
    name: 'Production gateway',
    baseUrl: 'https://api.example.test/v1',
    chatPath: 'tenant/chat/completions',
    modelsPath: 'tenant/models',
    authHeader: 'x-api-key',
    authPrefix: ''
  });
});
