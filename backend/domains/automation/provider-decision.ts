import { randomUUID } from 'node:crypto';
import { providerForConversationId, webProviderConversationId, type WebProviderId } from '../../../contracts/web-providers.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import {
  claimBrowserInput,
  completeBrowserDecision,
  publishBrowserDecision,
  requestBrowserDecision,
  type InputEntry
} from '../sessions/input/input.js';
import { onProviderPageProgress, requestProviderPageComplete } from '../providers/provider-page.js';

export async function requestProviderDecision(text: string, signal: AbortSignal, options: {
  sourceSessionId?: string;
  sourceConversationId?: string;
  publish?: (text: string) => void;
} = {}): Promise<string> {
  const provider: WebProviderId = providerForConversationId(options.sourceConversationId ?? '') ??
    getConfig().ui.webProvider ?? 'deepseek';
  return requestBrowserDecision(text, signal, {
    lifetime: 'temporary-planner',
    sourceSessionId: options.sourceSessionId,
    provider,
    providerConversationId: webProviderConversationId(provider, randomUUID()),
    publish: options.publish
  });
}

export async function deliverProviderDecision(entry: Pick<InputEntry, 'id' | 'text' | 'decisionProvider' | 'decisionConversationId'>, signal: AbortSignal): Promise<void> {
  if (!entry.decisionProvider || !entry.decisionConversationId) throw new Error('The provider decision identity is incomplete.');
  const owner = randomUUID();
  const claimed = await claimBrowserInput(entry.id, owner, null);
  if (!claimed) throw new Error('The provider decision could not be claimed safely.');
  const unsubscribe = onProviderPageProgress(progress => {
    if (progress.conversationId === entry.decisionConversationId) {
      void publishBrowserDecision(entry.id, owner, null, progress.text);
    }
  });
  try {
    const answer = await requestProviderPageComplete(entry.decisionProvider, entry.decisionConversationId, claimed.text, signal, { fresh: true });
    signal.throwIfAborted();
    if (!await completeBrowserDecision(entry.id, owner, answer.text)) throw new Error('The provider answer could not be committed to its decision record.');
  } finally {
    unsubscribe();
  }
}
