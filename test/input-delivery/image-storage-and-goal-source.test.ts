import {
  handlers,
  input,
  providerPage,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('exposes bounded image-storage accounting and rejects an unknown cleanup mode', async () => {
  const storage = await handlers.get('sessions:imageStorage')!(null, undefined);
  expect(storage).toMatchObject({ ok: true, data: { usedBytes: expect.any(Number), limitBytes: 2 * 1024 * 1024 * 1024 } });
  expect(await handlers.get('sessions:clearImageStorage')!(null, { mode: 'automatic' })).toMatchObject({ ok: false });
});

it('delivers Goal decisions through the source browser provider', async () => {
  const { requestProviderDecision } = await import('../../backend/domains/automation/provider-decision.js');
  const controller = new AbortController(), publish = vi.fn();
  const sourceConversationId = 'km-11111111-1111-4111-8111-111111111111';
  const answer = requestProviderDecision('Choose the next action', controller.signal, { sourceConversationId, publish });
  await vi.waitFor(() => expect(providerPage.pendingProviderPage()).toMatchObject({
    provider: 'kimi', text: 'Choose the next action', fresh: true
  }));
  const offer = providerPage.pendingProviderPage()!;
  const row = (await input.listInputs())[0]!;
  expect(row).toMatchObject({ purpose: 'decision', lifetime: 'temporary-planner', decisionProvider: 'kimi', decisionConversationId: offer.conversationId });
  const identity = { id: offer.id, provider: offer.provider, conversationId: offer.conversationId };
  expect(providerPage.reportProviderPageProgress({ ...identity, text: 'Provider is thinking' })).toBe(true);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith('Provider is thinking'));
  expect(providerPage.settleProviderPage({ ...identity, text: '{"next":"continue"}' })).toBe(true);
  await expect(answer).resolves.toBe('{"next":"continue"}');
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', response: '{"next":"continue"}' });
  expect(providerPage.pendingProviderPage()).toBeNull();
});

it('fails closed for a saved decision without a provider identity', async () => {
  const controller = new AbortController();
  await expect(input.requestBrowserDecision('Legacy decision prompt', controller.signal, { lifetime: 'temporary-planner' }))
    .rejects.toThrow('The saved decision has no provider identity');
  expect((await input.listInputs())[0]).toMatchObject({ state: 'cancelled' });
  expect(providerPage.pendingProviderPage()).toBeNull();
});
