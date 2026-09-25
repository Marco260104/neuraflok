import type http from 'node:http';

type Runtime = {
  shippedExtensionBuild(): string | null;
  wakeBrowserWork(): void;
  browserWakeConnected(): boolean;
};

type PendingReveal = { conversationId: string; settle(shown: boolean): void };

export function createBridgeCompanionClients(runtime: Runtime) {
  const browserSeenAt = new Map<string, number>();
  const browserChats = new Map<string, ReadonlySet<string>>();
  const openingCustody = new Map<string, string>();
  const revealBrowsers = new Map<string, number>();
  const pendingReveals: PendingReveal[] = [];
  const openingCustodyMs = 60_000;
  const revealCollectMs = 4_000;
  const freshBuildWindowMs = 60_000;
  const extensionBuildSeenAt = new Map<string, number>();

  function extensionBuildOf(req: http.IncomingMessage): string | null {
    const build = req.headers['x-extension-build'];
    return typeof build === 'string' && /^[0-9a-f]{12}$/.test(build) ? build : null;
  }

  function staleCompanion(req: http.IncomingMessage): boolean {
    const stamp = extensionBuildOf(req);
    const shipped = runtime.shippedExtensionBuild();
    if (!stamp || !shipped || stamp === shipped) return false;
    const current = extensionBuildSeenAt.get(shipped);
    return current !== undefined && Date.now() - current < freshBuildWindowMs;
  }

  function browserOf(req: http.IncomingMessage): string | null {
    const id = req.headers['x-extension-browser'];
    return typeof id === 'string' && /^[a-z0-9]{16,64}$/.test(id) ? id : null;
  }

  function noteExtensionBuild(req: http.IncomingMessage): void {
    const stamp = extensionBuildOf(req);
    if (!stamp) return;
    extensionBuildSeenAt.delete(stamp);
    extensionBuildSeenAt.set(stamp, Date.now());
    if (extensionBuildSeenAt.size > 16) extensionBuildSeenAt.delete(extensionBuildSeenAt.keys().next().value!);
  }

  function recordStatus(browser: string | null, openConversations: ReadonlySet<string>, post: boolean, canReveal: boolean): void {
    if (browser) browserSeenAt.set(browser, Date.now());
    if (browser && post) browserChats.set(browser, openConversations);
    if (post && canReveal) revealBrowsers.set(browser ?? '', Date.now());
  }

  function retireOpeningCustody(pendingIds: ReadonlySet<string>): void {
    for (const id of openingCustody.keys()) if (!pendingIds.has(id)) openingCustody.delete(id);
  }

  function openingHeldElsewhere(inputId: string, browser: string | null): boolean {
    if (!browser) return false;
    const holder = openingCustody.get(inputId);
    if (holder && holder !== browser && Date.now() - (browserSeenAt.get(holder) ?? 0) < openingCustodyMs) return true;
    openingCustody.set(inputId, browser);
    return false;
  }

  function chatHolders(conversationId: string): string[] {
    const now = Date.now();
    return [...browserChats]
      .filter(([browser, chats]) => chats.has(conversationId) && now - (browserSeenAt.get(browser) ?? 0) < openingCustodyMs)
      .map(([browser]) => browser);
  }

  function chatHeldElsewhere(conversationId: string, browser: string | null): boolean {
    if (!browser) return false;
    const holders = chatHolders(conversationId);
    return holders.length > 0 && !holders.includes(browser);
  }

  function inputHeldElsewhere(input: { id: string; conversationId: string | null }, browser: string | null): boolean {
    if (input.conversationId && chatHolders(input.conversationId).length > 0) return chatHeldElsewhere(input.conversationId, browser);
    return openingHeldElsewhere(input.id, browser);
  }

  function revealCapable(): boolean {
    const now = Date.now();
    return [...revealBrowsers.values()].some(at => now - at < openingCustodyMs);
  }

  function revealChatInBrowser(conversationId: string): Promise<boolean> {
    if (!runtime.browserWakeConnected() || !revealCapable()) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry: PendingReveal = { conversationId, settle: shown => { clearTimeout(timer); resolve(shown); } };
      const timer = setTimeout(() => {
        const index = pendingReveals.indexOf(entry);
        if (index >= 0) pendingReveals.splice(index, 1);
        resolve(false);
      }, revealCollectMs);
      timer.unref?.();
      pendingReveals.push(entry);
      runtime.wakeBrowserWork();
    });
  }

  function takeReveals(browser: string | null): string[] {
    const taken = pendingReveals.filter(entry => !chatHeldElsewhere(entry.conversationId, browser));
    for (const entry of taken) {
      pendingReveals.splice(pendingReveals.indexOf(entry), 1);
      entry.settle(true);
    }
    return [...new Set(taken.map(entry => entry.conversationId))];
  }

  function reset(): void {
    browserSeenAt.clear();
    browserChats.clear();
    revealBrowsers.clear();
    openingCustody.clear();
    extensionBuildSeenAt.clear();
    for (const entry of pendingReveals.splice(0)) entry.settle(false);
  }

  return {
    browserChats,
    browserOf,
    browserSeenAt,
    chatHeldElsewhere,
    chatHolders,
    extensionBuildOf,
    inputHeldElsewhere,
    noteExtensionBuild,
    openingCustody,
    openingHeldElsewhere,
    recordStatus,
    reset,
    revealBrowsers,
    revealChatInBrowser,
    staleCompanion,
    takeReveals,
    retireOpeningCustody
  };
}
