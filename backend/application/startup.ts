// NEURAFLOK main-process entry for startup, windows, tray and IPC coordination.

import path from 'node:path';
import { app, Notification, nativeTheme, screen, session } from 'electron';

// NEURAFLOK Modular Subsystems
import {
  getConfig, initConfigPath, loadConfig,
  initLogFile, logInfo, logWarn, logError, flushLogBeforeExit, snapshotLogOnCrash,
  initSecretsPath,
  mainText, restoreMainTextTranslations,
  initDurableStore, readDurable, writeDurableNow, writeDurableSoon, flushDurable
} from '../infrastructure/settings/index.js';

import {
  runShutdownSequence,
  startUpdateChecks, applyStagedUpdate,
  setStuckNotifier,
  initKeychainNotice, executableFingerprint,
  applyLoginStartup, isBackgroundLaunch, createWindowActivationGate, ownsAppRuntime, registerNativeWindowActivation,
  shouldBeginAppBootstrap, shouldQuitOnWindowAllClosed
} from '../infrastructure/desktop-shell/index.js';

import {
  initSessionStore, flushSessions,
  flushRecorder, queueDeterministicAttributionRepair, setAgentBinder, setAgentConversationLookup,
  restoreRequestCorrelations,
  restoreBlockedChats,
  restoreTrustedChats,
  requestSessionFinishGoal, setFinishNotifier,
  stopInputStartup,
  restoreContinuations, setContinuationRecoveryHooks,
  usageOverview,
  CONTINUATIONS_STATE,
  type ContinuationSnapshot
} from '../domains/sessions/index.js';

import {
  restoreSwarm, snapshotSwarm, onSwarmPersist, onSwarmPersistNow, pauseSwarmForDisable,
  bindConversation, agentConversation, archiveWorkerAssignments, primeFleetIn, repairPrimeConversationAfterRecovery,
  reconcileAgentRequestOwners,
  restoreRetiredWorkers, snapshotRetiredWorkers, onRetiredWorkersPersist, onRetiredWorkersPersistNow,
  startAgentRuntimeGc, stopAgentRuntimeGc,
  restoreGoalObjectives, restoreGoalReplies, restoreGoalSwitches,
  startLocalAgentDelivery, stopLocalAgentDelivery,
  GOAL_OBJECTIVES_STATE, GOAL_REPLIES_STATE, GOAL_SWITCHES_STATE,
  type RetiredWorkersSnapshot, type SwarmSnapshot,
  type GoalObjectivesSnapshot, type GoalRepliesSnapshot, type GoalSwitchesSnapshot
} from '../domains/automation/index.js';

import {
  startBridge, shutdownBridge,
  setBrowserOpener, setWorkAreaSource,
  initBrowserProofPath, loadBrowserProof,
  loadedIntegratedBrowser, syncIntegratedBrowser
} from '../domains/browser/index.js';

import { initSkillsPath } from '../domains/skills/index.js';
import { stopComputerHelper } from '../infrastructure/device-control/index.js';
import { initControlApiPath, startControlApi, shutdownControlApi } from '../infrastructure/local-api/index.js';

// Shared types and IPC bindings
import { browserExtensionRequired } from '../../contracts/types.js';
import { isMainText } from '../../contracts/main-texts.js';
import { registerIpc } from './ipc/register.js';
import { unifiedExecManager } from '../domains/workspace/execution/manager.js';
import { openInPreferredBrowser } from '../domains/browser/browser.js';
import { createTrayController, MAIN_TEXTS_STATE } from './tray-controller.js';
import { createMainWindowController } from './window-controller.js';

// Durable state file holding the multi-agent run; it stores hashes, never credentials.
const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';
const WINDOW_BOUNDS_STATE = 'window-bounds';
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
const usageWarmup = new AbortController();

// One instance only: two copies would compete for the browser bridge and shared settings.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a terminal secondary instance immediately, so neither native activation nor the async bootstrap below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
}

const windowController = createMainWindowController({
  isQuitting: () => quitting,
  onBoundsChanged: (placement) => writeDurableSoon(WINDOW_BOUNDS_STATE, placement)
});

setFinishNotifier((title, body, sessionId, turnId) => {
  if (windowController.getWindow()?.isFocused() || !Notification.isSupported()) return false;
  const write = (): void => {
    windowController.showWindow();
    const window = windowController.getWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  };
  const shown = (text: string): string => isMainText(text) ? mainText(text) : text;
  const notice = new Notification({ title: shown(title), body: shown(body), actions: [
    { type: 'button', text: mainText('Send Automatic Goal') }, { type: 'button', text: mainText('Write Directly') }
  ] });
  notice.on('click', write);
  notice.on('action', (details) => {
    if (details.actionIndex === 0) void requestSessionFinishGoal(sessionId, turnId).catch(error => logWarn(`Finish goal: ${error.message}`));
    else if (details.actionIndex === 1) write();
  });
  notice.show();
  return true;
});
setStuckNotifier((title, body, sessionId) => {
  // A person looking at the app already has the timeline note this accompanies; interrupting them with the same sentence is noise, exactly as the finish notice treats a focused window.
  if (windowController.getWindow()?.isFocused() || !Notification.isSupported()) return false;
  const notice = new Notification({ title, body });
  notice.on('click', () => {
    windowController.showWindow();
    const window = windowController.getWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  });
  notice.show();
  return true;
});
setWorkAreaSource(() => screen.getPrimaryDisplay().workArea);

// Electron promises `second-instance` only after its own `ready`, not after our async startup. Until CSP/permission handlers and IPC are installed below, a re-launch is only a focus request for the initial window that startup is already going to show, so do not construct one early.
const windowActivation = createWindowActivationGate(windowController.showWindow);
const trayController = createTrayController({
  openWindow: windowActivation.request,
  quitApplication: () => {
    quitting = true;
    app.quit();
  }
});

app.on('second-instance', (_event, argv) => {
  if (!isBackgroundLaunch(argv)) windowActivation.request();
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  const userData = app.getPath('userData');
  initLogFile(path.join(userData, 'app.log'));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    snapshotLogOnCrash(`${origin}: ${error.stack ?? error.message}`);
  });
  initConfigPath(userData);
  initBrowserProofPath(userData);
  initSecretsPath(userData);
  initKeychainNotice(userData, {
    platform: process.platform,
    contents: () => {
      const window = windowController.getWindow();
      return window && !window.isDestroyed() ? window.webContents : null;
    },
    fingerprint: () => executableFingerprint(app.getVersion())
  });
  initSessionStore(userData);
  try { await initSkillsPath(userData); }
  catch (error) { logWarn(`Skills library unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  initDurableStore(userData);
  windowController.setSavedBounds(await readDurable<unknown>(WINDOW_BOUNDS_STATE));
  restoreMainTextTranslations(await readDurable<unknown>(MAIN_TEXTS_STATE));
  if (windowActivation.isDisabled()) return;
  initControlApiPath(userData);
  if (windowActivation.isDisabled()) return;
  await loadConfig();
  await loadBrowserProof();
  if (windowActivation.isDisabled()) return;
  try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
  catch (error) { logWarn(`Windows login startup: ${error instanceof Error ? error.message : String(error)}`); }
  // The renderer has its own explicit light/dark palette, so native chrome must follow the same user choice instead of Electron's default `system` theme. On macOS this controls the window frame, application menus and OS dialogs; on Linux/Windows it covers Electron-native UI.
  nativeTheme.themeSource = getConfig().ui.theme;
  const savedGoalObjectives = await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalObjectives(savedGoalObjectives);
  const savedGoalSwitches = await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalSwitches(savedGoalSwitches);
  const savedGoalReplies = await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalReplies(savedGoalReplies);
  // Restore exact request ownership before bridge traffic can arrive, regardless of provider-tab lifetime.
  await restoreRequestCorrelations();
  if (windowActivation.isDisabled()) return;
  // Restore user blocks before any bridged call can reach local tools.
  await restoreBlockedChats();
  if (windowActivation.isDisabled()) return;
  // Restore exact trust entries before model-facing endpoints can accept work.
  await restoreTrustedChats();
  if (windowActivation.isDisabled()) return;
  setAgentConversationLookup(agentConversation);
  // Bind a prime chat when its first local tool call is recorded because the extension cannot name it.
  setAgentBinder(bindConversation);
  // Configure the shared browser launcher before pending provider-page work is restored.
  setBrowserOpener(async (url) => {
    // Keep launch failures with the command owner and the browser profile it selected.
    await openInPreferredBrowser(url);
  });

  // Persistence is a process-lifetime dependency of the broker, not a feature-toggle dependency. Multi-agent can be enabled from Settings without restarting the process; keeping both sinks wired from startup guarantees the first spawn can cross its durable acceptance barrier even when this launch began with multi-agent disabled.
  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));

  // A multi-agent run outlives this process. Restoring it before the bridge starts means a worker that never joined gets its chat re-requested through the same queue as a fresh one, rather than being stranded with a key nobody has.
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  const retiredWorkers = await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE);
  if (windowActivation.isDisabled()) return;
  restoreRetiredWorkers(retiredWorkers);
  const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE);
  if (windowActivation.isDisabled()) return;
  // From the saved snapshot itself, so families the restore prunes as expired keep their names in history; in the background, since startup does not wait on presentation.
  void archiveWorkerAssignments(savedSwarm);
  restoreSwarm(savedSwarm);
  if (!getConfig().multiAgent.enabled) {
    // A feature toggle is a pause, not Clear swarm. Canonicalize any active incarnation left by a crash into stopped prime-owned history before the bridge exists, then make that safer projection durable. Re-enabling later in this process or after another restart recovers the same exact worker conversations without letting disabled workers consume execution slots.
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
    if (windowActivation.isDisabled()) return;
  }
  // Continuation recovery is after swarm restore because an interrupted durable rebind may have to finish publishing the prime transfer that was frozen in that snapshot.
  setContinuationRecoveryHooks({
    repairPrimeTransfer: repairPrimeConversationAfterRecovery,
    hasPrimeFleet: primeFleetIn
  });
  const savedContinuations = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
  if (windowActivation.isDisabled()) return;
  await restoreContinuations(savedContinuations);
  if (windowActivation.isDisabled()) return;
  await reconcileAgentRequestOwners();
  if (windowActivation.isDisabled()) return;
  startLocalAgentDelivery();
  // Runtime GC consumes restored broker/session/exec ownership only. It owns no worker lifecycle state and does not run until its first coarse interval after this point.
  startAgentRuntimeGc();

  // Strict CSP for our own page. There is no remote content and no inline script.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // From here on a second launch may safely focus/recreate the window: renderer security policy is installed and the renderer's fixed IPC methods already have handlers before it can load. The same quit the tray's Quit performs. It has to go through `quitting` for the window's close-to-tray handler to let go: without it, quitting to install would hide the window and leave the app running, which is exactly the trap the Install button exists to end.
  registerIpc(
    windowController.getWindow,
    () => {
      quitting = true;
      app.quit();
    }
  );
  windowActivation.enable();
  if (!isBackgroundLaunch(process.argv)) windowActivation.request();
  // macOS `activate` can fire on first launch, so do not wire it at module load where it could create a BrowserWindow before Electron is ready. Once the initial window path is established, Dock activation/re-launch can safely recreate or focus it.
  registerNativeWindowActivation(app, windowActivation.request);

  // Recording, workers and direct browser tools share one extension transport. Start the companion
  // before the tray: a stuck native tray must not leave DeepSeek/Kimi/Qwen signed out.
  if (browserExtensionRequired(getConfig())) {
    void startBridge().finally(() => void syncIntegratedBrowser());
  } else void syncIntegratedBrowser();

  try {
    await trayController.start();
  } catch (error) {
    logWarn(`tray did not start: ${error instanceof Error ? error.message : String(error)}`);
  }

  logInfo('app started');

  // Historical Unattributed repair may legitimately scan and rewrite a large legacy bucket. It is maintenance, not a prerequisite for showing the app or accepting new exact-id traffic, so never make startup/reload wait behind years of old session history.
  queueDeterministicAttributionRepair();
  // Opt-in, and only once every fact it projects has been restored. ipc.ts starts and stops it when the setting changes; a failed bind is logged and leaves the rest of the app untouched.
  if (getConfig().controlApi.enabled) {
    startControlApi().catch((error: Error) => logWarn(`control API did not start: ${error.message}`));
  }

  // Never awaited: an unreachable GitHub, a slow download or a broken release must not delay a window that is already on screen. Everything it learns arrives through the ordinary state push, every failure ends inside it, and its own timer keeps it running for a tray app that is never restarted.
  startUpdateChecks();
  // Warm the existing derived cache once, after startup, without delaying the UI. A visit to Usage joins this same calculation; unchanged recordings cost no reads.
  void usageOverview(usageWarmup.signal).catch((error: Error) => {
    if (!usageWarmup.signal.aborted) logWarn(`usage background refresh failed: ${error.message}`);
  });
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  // From this point `will-quit` owns a bounded teardown. A Dock click/relaunch arriving while that sequence drains must not recreate or reveal a window after the tray has disappeared.
  windowActivation.disable();
  usageWarmup.abort();
  void stopAgentRuntimeGc();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // macOS convention: closing the last window is not quitting the application. The Dock/menu bar stay alive and `activate` recreates it. Windows/Linux retain the explicit close-to-tray preference; Cmd+Q / app.quit bypasses this event and still enters the shutdown sequence.
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be allowed to exit normally: preventing that quit and flushing/stopping the primary's shared stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopInputStartup();
  trayController.destroy();

  void runShutdownSequence(
    [
      // Phase 1: stop local listeners from admitting work and drain accepted requests. The control API drains within 2s; stopping it also removes its token file.
      {
        name: 'admission/drain',
        budgetMs: 40_000,
        run: () => [shutdownBridge(), shutdownControlApi(), stopAgentRuntimeGc(), stopLocalAgentDelivery()]
      },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopComputerHelper(),
          Promise.resolve().then(() => loadedIntegratedBrowser()?.stop())]
      },
      // Phase 3: recorder work can enqueue both session projections and named durable state.
      { name: 'recorder flush', budgetMs: 10_000, run: () => [flushRecorder()] },
      // These are independent writers. One rejection must never skip the other flush.
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushSessions(), flushDurable()] },
      // Last, because it is the one phase whose effect is meant to outlive this process: a staged update is handed to the platform's installer here, so the next start of the app is the new version. Nothing is staged unless it downloaded whole and matched the release's published SHA-256, and applying it cannot fail loudly - see update.ts.
      { name: 'update handoff', budgetMs: 5_000, run: () => [applyStagedUpdate()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the continuation that ends this sequence is dropped by Electron, and the app is left running with nothing to click and the single-instance lock still held.
      exit: () => {
        // The sequence has just logged its completion; a phase inside it would flush too early.
        void flushLogBeforeExit().finally(() => {
          shutdownComplete = true;
          app.exit(0);
        });
      }
    }
  );
});

// Belt and braces: no web contents anywhere in this app may open a window or navigate. External links go through the vetted allowlist in ipc.ts instead. The NEURAFLOK browser's provider pages need navigation and redirects while users sign in.
app.on('web-contents-created', (_event, contents) => {
  if (loadedIntegratedBrowser()?.browses(contents)) return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});
