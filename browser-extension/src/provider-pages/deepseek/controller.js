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
    keys: () => ({ session: 'neuraflok.providerSession', claim: 'neuraflok.sendClaim' }),
    legacyKeys: () => ({
      'neuraflok.providerSession': 'neuraljam.providerSession',
      'neuraflok.sendClaim': 'neuraljam.sendClaim'
    }),
    includeThink: true,
    bindUnclaimed: true,
    openNewPageOnFresh: true,
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
    signInMessage: 'Sign in to DeepSeek at chat.deepseek.com in the same browser as this app, then send again.',
    mark: { id: 'neuraflok-deepseek-badge', text: () => 'NEURAFLOK' },
    legacyMarkIds: ['neural-jam-deepseek-badge']
  });
})();
