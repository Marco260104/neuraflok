import type { WebProviderId } from '../../../../contracts/web-providers.js';
import { createSessionPaths } from './session-paths.js';

export const sessionPaths = createSessionPaths();

export function initializeSessionPaths(userDataDir: string): void {
  sessionPaths.initialize(userDataDir);
}

export function sessionsRoot(): string {
  return sessionPaths.getRoot();
}

export function sessionSearchIndexPath(id: string): string {
  return sessionPaths.sessionSearchIndexPath(id);
}

export function sessionWebProviderThreadPath(id: string, provider: WebProviderId): string {
  return sessionPaths.sessionWebProviderThreadPath(id, provider);
}

export function sessionApiThreadPath(id: string): string {
  return sessionPaths.sessionApiThreadPath(id);
}

export function sessionDir(id: string): string {
  return sessionPaths.sessionDirectory(id);
}
