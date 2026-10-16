(() => {
  if (globalThis.__neuraflokProviderContent) return;
  const api = globalThis.NEURAFLOK_PROVIDER;
  const agent = globalThis.NEURAFLOK_PAGE_AGENT;
  if (!api || !agent || typeof api.provider !== 'string') return;

  const provider = api.provider;
  const prefixes = { kimi: 'km', qwen: 'qw', glm: 'gm' };
  if (!prefixes[provider]) return;

  agent.install({
    guard: '__neuraflokProviderContent',
    api,
    provider,
    prefix: prefixes[provider],
    namespace: 'neuraflok-provider',
    keys: current => ({
      session: `neuraflok.session.${current}`,
      claim: `neuraflok.sendClaim.${current}`
    }),
    legacyKeys: current => ({
      [`neuraflok.session.${current}`]: `neuraljam.session.${current}`,
      [`neuraflok.sendClaim.${current}`]: `neuraljam.sendClaim.${current}`
    }),
    includeProvider: true,
    verifySignIn: true,
    composerMs: 15_000,
    idleMs: 20_000,
    insertMs: 4_000,
    sendMs: 5_000,
    startMs: 20_000,
    finishMs: 25_000,
    signInMessage: `Sign in to ${provider.toUpperCase()} in this browser, then try again.`,
    mark: { id: 'neuraflok-provider-mark', text: current => `NEURAFLOK · ${current.toUpperCase()}` },
    legacyMarkIds: ['neural-jam-provider-mark']
  });
})();
