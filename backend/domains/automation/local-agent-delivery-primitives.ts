import { createHash } from 'node:crypto';
import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { providerForConversationId, type WebProviderId } from '../../../contracts/web-providers.js';
import type { InputArgs } from '../sessions/input/input.js';

export interface DeliveryRoute {
  executor: 'api' | WebProviderId;
  provider: WebProviderId | null;
}

export function deterministicDeliveryUuid(value: string): string {
  const bytes = createHash('sha256').update(`neuraflok:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function routeForConversation(conversationId: string): DeliveryRoute {
  if (isApiConversationId(conversationId)) return { executor: 'api', provider: null };
  const provider = providerForConversationId(conversationId);
  if (!provider) throw new Error('The owning conversation uses an unsupported provider route.');
  return { executor: provider, provider };
}

export function workerInput(
  id: string,
  sessionId: string,
  text: string,
  route: DeliveryRoute,
  model: string | null,
  reasoningEffort: InputArgs['reasoningEffort']
): InputArgs {
  return {
    id,
    sessionId,
    text,
    mode: 'auto',
    dueAt: Date.now(),
    model,
    reasoningEffort,
    ...(route.provider ? { webProvider: route.provider } : {})
  };
}
