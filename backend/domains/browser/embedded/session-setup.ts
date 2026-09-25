import { app, type Session } from 'electron';
import path from 'node:path';
import { logInfo } from '../../../infrastructure/settings/logger.js';
import type { WorkerStatus } from './extension-worker.js';

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

function chromiumUserAgent(agent: string): string {
  let cleaned = agent.replace(/\s(?:Electron|NEURAFLOK)\/\S+/gi, '');
  if (/Electron/i.test(cleaned)) cleaned = cleaned.replace(/Electron\/\S+\s?/gi, '');
  return cleaned;
}

export function configureIntegratedBrowserSession(
  ses: Session,
  preloadDir: string,
  statusChanged: (versionId: number, runningStatus: WorkerStatus) => void,
  trace: boolean
): void {
  ses.setUserAgent(chromiumUserAgent(app.userAgentFallback));
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(preloadDir, 'integrated-browser-worker.js') });
  ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (trace) logInfo(`integrated browser trace: worker ${versionId} ${runningStatus}`);
    statusChanged(versionId, runningStatus);
  });
  if (trace) {
    ses.serviceWorkers.on('console-message', (_event, details) => {
      logInfo(`integrated browser trace: worker console ${details.level ?? ''}: ${String(details.message).slice(0, 400)}`);
    });
  }
}
