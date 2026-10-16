import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ provider: 'deepseek' as 'deepseek' | 'kimi' | 'qwen' | 'glm' }));
vi.mock('../backend/infrastructure/settings/config.js', async original => {
  const real = await original<typeof import('../backend/infrastructure/settings/config.js')>();
  return { ...real, getConfig: () => ({ ...real.defaultConfig(), ui: { ...real.defaultConfig().ui, webProvider: state.provider } }) };
});

const { goalProgressFor } = await import('../backend/domains/automation/goal.js');

beforeEach(() => { state.provider = 'deepseek'; });

it.each([
  ['deepseek', 'DeepSeek'],
  ['kimi', 'Kimi'],
  ['qwen', 'Qwen'],
  ['glm', 'Z AI']
] as const)('reports the selected provider %s in Goal progress', (provider, label) => {
  state.provider = provider;
  expect(goalProgressFor('goal')).toMatchObject({ backend: 'web', model: label });
});
