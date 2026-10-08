import {
  decision,
  defaultConfig,
  goal,
  saveConfig,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('API task planner reasoning', () => {
  it.each(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)('uses the configured %s setting in the actual request body', async reasoning => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', model: 'z-ai/glm-5.3-flash', reasoning } });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('z-ai/glm-5.3-flash');
      expect(body.reasoning).toEqual(reasoning === 'default' ? { exclude: true } : { effort: reasoning, exclude: true });
      expect(body.messages[0].content).toContain('ENTIRE workflow in its first message');
      expect(body.messages[0].content).toContain('early delegation in Stage 1');
      expect(body.messages[0].content).toContain('verification and improvement checkpoints');
      expect(body.messages.find((message: { role: string }) => message.role === 'user').content).toContain('Produce the requested staged workflow');
      expect(JSON.stringify(body.messages)).not.toContain('You only write the next prompt');
      return decision('continue', JSON.stringify({ stages: ['Implement the requested change', 'Verify acceptance'] }));
    });
    globalThis.fetch = fetch as typeof globalThis.fetch;
    expect(await goal.draftTaskPlan('Implement the change and verify it', 'api')).toEqual(['Implement the requested change', 'Verify acceptance']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
