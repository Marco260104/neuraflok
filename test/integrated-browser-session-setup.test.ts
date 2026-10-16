import path from 'node:path';
import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  userAgentFallback: 'Mozilla/5.0 Chrome/130.0 Electron/44.0 NEURAFLOK/0.1.0',
  logInfo: vi.fn()
}));

vi.mock('electron', () => ({ app: { userAgentFallback: fixture.userAgentFallback } }));
vi.mock('../backend/infrastructure/settings/logger.js', () => ({ logInfo: fixture.logInfo }));

import { configureIntegratedBrowserSession } from '../backend/domains/browser/embedded/session-setup.js';

describe('integrated browser session setup', () => {
  it('keeps a browser user agent, bounded permissions, preload, and worker status delivery', () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const session = {
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      registerPreloadScript: vi.fn(),
      serviceWorkers: { on: vi.fn((name: string, listener: (...args: any[]) => void) => listeners.set(name, listener)) }
    } as unknown as Session;
    const statusChanged = vi.fn();
    configureIntegratedBrowserSession(session, path.join('app', 'preloads'), statusChanged, false);
    expect(session.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Chrome/130.0');
    expect(session.registerPreloadScript).toHaveBeenCalledWith({
      type: 'service-worker', filePath: path.join('app', 'preloads', 'integrated-browser-worker.js')
    });
    const check = vi.mocked(session.setPermissionCheckHandler).mock.calls[0]![0] as unknown as
      (_contents: unknown, permission: string) => boolean;
    expect(check(null, 'fullscreen')).toBe(true);
    expect(check(null, 'notifications')).toBe(false);
    const request = vi.mocked(session.setPermissionRequestHandler).mock.calls[0]![0] as unknown as
      (_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const respond = vi.fn();
    request(null, 'clipboard-sanitized-write', respond);
    expect(respond).toHaveBeenCalledWith(true);
    listeners.get('running-status-changed')?.({ versionId: 7, runningStatus: 'running' });
    expect(statusChanged).toHaveBeenCalledWith(7, 'running');
    expect(listeners.has('console-message')).toBe(false);
  });
});
