import { beforeEach, expect, it, vi } from 'vitest';

const input = vi.hoisted(() => ({ request: vi.fn(), claim: vi.fn(), complete: vi.fn(), publish: vi.fn() }));
const page = vi.hoisted(() => ({ complete: vi.fn(), listeners: new Set<(progress: any) => void>() }));
vi.mock('../backend/domains/sessions/input/input.js', () => ({
  claimBrowserInput: input.claim,
  completeBrowserDecision: input.complete,
  publishBrowserDecision: input.publish,
  requestBrowserDecision: input.request
}));
vi.mock('../backend/domains/providers/provider-page.js', () => ({
  onProviderPageProgress: (listener: (progress: any) => void) => {
    page.listeners.add(listener);
    return () => page.listeners.delete(listener);
  },
  requestProviderPageComplete: page.complete
}));
vi.mock('../backend/infrastructure/settings/config.js', () => ({ getConfig: () => ({ ui: { webProvider: 'deepseek' } }) }));

const { deliverProviderDecision, requestProviderDecision } = await import('../backend/domains/automation/provider-decision.js');

beforeEach(() => {
  input.request.mockReset();
  input.claim.mockReset();
  input.complete.mockReset();
  input.publish.mockReset();
  page.complete.mockReset();
  page.listeners.clear();
});

it('routes a Goal helper through the provider bound to its source chat', async () => {
  input.request.mockResolvedValue('decision');
  const sourceConversationId = 'km-11111111-1111-4111-8111-111111111111';
  const publish = vi.fn();
  const signal = new AbortController().signal;
  await expect(requestProviderDecision('Decide this task', signal, {
    sourceSessionId: 'source-session-123', sourceConversationId, publish
  })).resolves.toBe('decision');
  expect(input.request).toHaveBeenCalledWith('Decide this task', signal, expect.objectContaining({
    lifetime: 'temporary-planner',
    sourceSessionId: 'source-session-123',
    provider: 'kimi',
    providerConversationId: expect.stringMatching(/^km-[0-9a-f-]{36}$/),
    publish
  }));
});

it('claims the exact durable decision before sending and publishes only matching progress', async () => {
  const entry = {
    id: '22222222-2222-4222-8222-222222222222',
    text: 'Frozen decision prompt',
    decisionProvider: 'qwen' as const,
    decisionConversationId: 'qw-11111111-1111-4111-8111-111111111111'
  };
  const signal = new AbortController().signal;
  input.claim.mockResolvedValue({ text: 'Claimed prompt bytes' });
  page.complete.mockImplementation(async () => {
    for (const listener of page.listeners) {
      listener({ conversationId: 'foreign-conversation', text: 'ignored' });
      listener({ conversationId: entry.decisionConversationId, text: 'provider progress' });
    }
    return { text: 'provider answer' };
  });
  input.complete.mockResolvedValue(true);

  await deliverProviderDecision(entry, signal);

  const owner = input.claim.mock.calls[0]?.[1];
  expect(owner).toMatch(/^[0-9a-f-]{36}$/i);
  expect(input.claim).toHaveBeenCalledWith(entry.id, owner, null);
  expect(page.complete).toHaveBeenCalledWith(entry.decisionProvider, entry.decisionConversationId, 'Claimed prompt bytes', signal, { fresh: true });
  expect(input.publish).toHaveBeenCalledWith(entry.id, owner, null, 'provider progress');
  expect(input.publish).not.toHaveBeenCalledWith(entry.id, owner, null, 'ignored');
  expect(input.complete).toHaveBeenCalledWith(entry.id, owner, 'provider answer');
  expect(page.listeners.size).toBe(0);
});

it('does not open a provider page when the durable input claim is unavailable', async () => {
  input.claim.mockResolvedValue(null);
  await expect(deliverProviderDecision({
    id: '33333333-3333-4333-8333-333333333333',
    text: 'Decision prompt',
    decisionProvider: 'deepseek',
    decisionConversationId: 'ds-11111111-1111-4111-8111-111111111111'
  }, new AbortController().signal)).rejects.toThrow('could not be claimed safely');
  expect(page.complete).not.toHaveBeenCalled();
});
