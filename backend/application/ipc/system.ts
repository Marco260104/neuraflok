import { app, clipboard, shell } from 'electron';
import { z } from 'zod';
import { usageOverview } from '../../domains/sessions/history/usage.js';
import { logInfo, getLog, formatLogAsJson, formatLogForClipboard } from '../../infrastructure/settings/logger.js';
import { readRecentLog, renderDiagnosticsReport, saveDiagnosticsReport, systemFacts } from '../../infrastructure/diagnostics/report.js';
import { listSessions } from '../../domains/sessions/history/store.js';
import { listProjects } from '../../domains/workspace/projects.js';
import { bridgeStatus, companionDiagnostics, pendingCommands } from '../../domains/browser/bridge.js';
import { swarmState } from '../../domains/automation/agents.js';
import { markInstallOnQuit, manualDownloadUrl, updateStatus, checkForUpdatesIfStale } from '../../infrastructure/desktop-shell/update.js';
import { refreshMacOSDesktopAccess } from '../../infrastructure/device-control/native/index.js';
import type { IpcRouteContext } from './types.js';

export function registerSystemIpc({ handle, getWindow, buildState, quitToInstall }: Pick<IpcRouteContext, 'handle' | 'getWindow' | 'buildState'> & { quitToInstall: () => void }): void {
  handle('usage:get', () => usageOverview());
  handle('state:get', async () => {
    const state = await buildState();
    // Native package smoke uses this as the end-to-end renderer readiness barrier. Unlike `did-finish-load`, it can only happen after the renderer's first IPC request has completed secure-storage availability/decryption probes and the rest of the initial state snapshot.
    logInfo('renderer state ready');
    return state;
  });


  // "Save diagnostics report": one plain-text file for a bug report, personal details removed (see diagnostics-report.ts). Revealed after saving so the user reads what they would share.
  handle('diagnostics:saveReport', async () => {
    const workers = swarmState().agents;
    const text = renderDiagnosticsReport({
      app: systemFacts(app), home: app.getPath('home'),
      bridge: await bridgeStatus(), extension: await companionDiagnostics().catch(() => null),
      commands: pendingCommands().map(({ id, what, lastError }) => ({ command: id, what, lastError })),
      workers: workers.map(({ id, role, state, model, reasoningEffort, createdAt, activatedAt, finishedAt, pending, delivered, conversationId, revivable }) =>
        ({ worker: id, role, state, model, reasoningEffort, createdAt, activatedAt, finishedAt, pending, delivered, conversationId, revivable })),
      sessions: await listSessions().catch(() => []),
      projects: await listProjects().catch(() => []),
      workerTexts: workers.flatMap(worker => [worker.task ?? '', worker.label ?? '', worker.result ?? '']),
      log: await readRecentLog(),
      now: Date.now()
    });
    return saveDiagnosticsReport(text, getWindow());
  });
  handle('desktop:requestAccessibility', async () => {
    await refreshMacOSDesktopAccess({ promptAccessibility: true });
    return buildState();
  });

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    await clipboard.writeText(text);
    return true;
  });

  // Copy or save a completed turn's answer, or the session transcript, as Markdown. Main reads the full text of answers that were cut in the log, so neither comes out truncated.

  handle('update:install', async () => {
    if (!markInstallOnQuit()) throw new Error('There is no downloaded update to install yet');
    logInfo('update: install requested; quitting to hand the update over');
    quitToInstall();
    return true;
  });

  // "Get update" for an installation that cannot update itself: the exact published file for this machine and the announced version, opened in the user's browser. The renderer names nothing; the URL is built here from the checked release and this process's platform. Opening Settings: ask GitHub again if the last answer is older than ten minutes. The status reaches the window through the ordinary state push; this returns before the check does.
  handle('update:refresh', async () => {
    void checkForUpdatesIfStale();
    return true;
  });

  handle('update:download', async () => {
    const url = manualDownloadUrl(updateStatus().latest);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });

  // Bridge section.


}
