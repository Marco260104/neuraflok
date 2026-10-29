(() => {
  if (globalThis.__neuraflokDeepseekContent) return;
  const api = globalThis.NEURAFLOK_DEEPSEEK;
  const agent = globalThis.NEURAFLOK_PAGE_AGENT;
  if (!api || !agent) return;

  agent.install({
    guard: '__neuraflokDeepseekContent',
    api,
    provider: 'deepseek',
    prefix: 'ds',
    namespace: 'neuraflok-deepseek',
    keys: () => ({ session: 'neuraflok.providerSession', claim: 'neuraflok.sendClaim', preparedAttachmentPage: 'neuraflok.preparedAttachmentPage' }),
    legacyKeys: () => ({
      'neuraflok.providerSession': 'neuraljam.providerSession',
      'neuraflok.sendClaim': 'neuraljam.sendClaim'
    }),
    includeThink: true,
    allowPreparedAttachmentPage: true,
    bindUnclaimed: true,
    rejectBoundFresh: true,
    composerMs: 15_000,
    // Long DeepSeek generations can remain active while NeuraFlok is preparing
    // the next tool round. Give the current reply time to settle before failing
    // the queued follow-up as a provider error.
    idleMs: 120_000,
    insertMs: 3_000,
    sendMs: 5_000,
    startMs: 20_000,
    finishMs: 25_000,
    signInMessage: 'NeuraFlok could not verify the DeepSeek session or chat controls through its browser companion. No sign-in state was changed and no message was sent. Refresh the DeepSeek page and retry; if DeepSeek itself shows a sign-in page, sign in there.',
    reportAttachmentsUploaded: details => new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({
          type: 'neuraflok-deepseek-attachment-uploaded',
          id: details.id,
          conversationId: details.conversationId
        }, response => {
          void chrome.runtime.lastError;
          resolve(response);
        });
      } catch { resolve(null); }
    }),
    attachmentMs: 300_000,
    mark: { id: 'neuraflok-deepseek-badge', text: () => 'NEURAFLOK' },
    legacyMarkIds: ['neural-jam-deepseek-badge']
  });
})();
