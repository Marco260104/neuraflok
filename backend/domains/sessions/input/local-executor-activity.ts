/** Provider turns waiting for the single browser-page slot are live work, even before the provider starts generating. */
const queuedConversations = new Set<string>();

export function setLocalProviderTurnQueued(conversationId: string, queued: boolean): void {
  if (queued) queuedConversations.add(conversationId);
  else queuedConversations.delete(conversationId);
}

export function isLocalProviderTurnQueued(conversationId: string): boolean {
  return queuedConversations.has(conversationId);
}

export function resetLocalProviderTurnQueueForTests(): void {
  queuedConversations.clear();
}
