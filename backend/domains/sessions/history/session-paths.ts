import path from 'node:path';
import type { WebProviderId } from '../../../../contracts/web-providers.js';

export function createSessionPaths() {
  let root = '';

  function initialize(userDataDir: string): void {
    root = path.join(userDataDir, 'sessions');
  }

  function assertReady(): void {
    if (root === '') throw new Error('The session store was used before initSessionStore() named a directory');
  }

  function assertSessionId(id: string): void {
    if (!/^[0-9a-z-]{8,64}$/i.test(id)) throw new Error('Invalid session id');
  }

  function sessionDirectory(id: string): string {
    assertReady();
    return path.join(root, id);
  }

  function sessionSearchIndexPath(id: string): string {
    assertSessionId(id);
    return path.join(sessionDirectory(id), 'search.txt');
  }

  function sessionWebProviderThreadPath(id: string, provider: WebProviderId): string {
    assertSessionId(id);
    return provider === 'deepseek'
      ? path.join(sessionDirectory(id), 'deepseek-thread.json')
      : path.join(sessionDirectory(id), `web-${provider}-thread.json`);
  }

  function sessionApiThreadPath(id: string): string {
    assertSessionId(id);
    return path.join(sessionDirectory(id), 'api-thread.json');
  }

  return {
    assertReady,
    assertSessionId,
    getRoot: () => root,
    initialize,
    sessionApiThreadPath,
    sessionDirectory,
    sessionSearchIndexPath,
    sessionWebProviderThreadPath,
    unset: () => { root = ''; }
  };
}
