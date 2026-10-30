import { registerWorkspaceTerminalIpc } from '../../domains/workspace/workspace-terminal-ipc.js';
import { registerSkillsIpc } from './skills.js';
import { registerSettingsIpc } from './settings.js';
import { registerSystemIpc } from './system.js';
import { registerAutomationIpc } from './automation.js';
import { registerBrowserIpc } from './browser.js';
import { registerWorkspaceIpc } from './workspace.js';
import { registerSessionIpc } from './sessions.js';
export { cleanSessionName, openSessionChat } from './sessions.js';
import { packagedRuntime } from '../../infrastructure/desktop-shell/runtime-packaging.js';
import { supportsLoginStartup } from '../../infrastructure/desktop-shell/window-lifecycle.js';
import { prepareSessionPrompt, prepareSkillFollowup } from '../../domains/sessions/input/prompt.js';
import { noteChatOrigin, onSessionChange } from '../../domains/sessions/history/recorder.js';
import { OFFLINE_GOAL_MARKER_INSTRUCTION } from '../../../contracts/automation/offline-goal-catalog.js';
import { recordDeliveredInput } from '../../domains/sessions/input/input-history.js';
import { configureInputDelivery } from '../../domains/sessions/input/input.js';
import { deliverProviderDecision } from '../../domains/automation/provider-decision.js';
import { onGoalChange, goalBackendFor, goalSwitchFor, setGoalSwitchNow, setGoalReplyActiveNow, setGoalObjectiveNow } from '../../domains/automation/goal.js';
import { app, BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import type { AppState } from '../../../contracts/types.js';
import { getConfig, settingsRecovered } from '../../infrastructure/settings/config.js';
import { onBackgroundExecChange } from '../../domains/workspace/execution/ownership.js';
import { logInfo, onLog } from '../../infrastructure/settings/logger.js';
import { SandboxError } from '../../infrastructure/settings/sandbox.js';
import { hasSecret, secureStorageStatus } from '../../infrastructure/settings/secrets.js';
import {
  bridgeStatus,
  sessionInputActivity,
  recoveryHeldByCalls, recoveryInputAllowed,
  onBridgeChange,
  startBridge
} from '../../domains/browser/bridge.js';
import { getSession, withSessionMutationFence } from '../../domains/sessions/history/store.js';
import { setChatsTrusted } from '../../domains/sessions/continuity/trusted-chats.js';
import { onSwarmChange, swarmState } from '../../domains/automation/agents.js';
import { hostPlatformInfo } from '../../infrastructure/settings/platform.js';
import { onUpdateChange, updateStatus } from '../../infrastructure/desktop-shell/update.js';
import { getMacOSDesktopAccess, onMacOSDesktopAccessChange } from '../../infrastructure/device-control/native/index.js';

async function buildState(): Promise<AppState> {
  const config = getConfig();
  const debugStartup = process.env['NEURAFLOK_DEBUG'] === '1';
  const readStartupField = async <T>(name: string, read: () => Promise<T>): Promise<T> => {
    if (debugStartup) logInfo(`startup state: ${name} starting`);
    const value = await read();
    if (debugStartup) logInfo(`startup state: ${name} ready`);
    return value;
  };
  return {
    config,
    platform: hostPlatformInfo(),
    loginStartupAvailable: supportsLoginStartup(process.platform, packagedRuntime(app.isPackaged, process.execPath)),
    secureStorage: await readStartupField('secure credential storage', () => secureStorageStatus()),
    hasGoalKey: await readStartupField('goal credential', () => hasSecret('openRouterApiKey')),
    hasOpenAiModelKey: await readStartupField('OpenAI credential', () => hasSecret('openaiChatApiKey')),
    hasCustomProviderKey: await readStartupField('custom provider credential', () => hasSecret('customProviderApiKey')),
    hasCustomProviderHeaders: await readStartupField('custom API headers', () => hasSecret('customProviderHeaders')),
    bridge: await readStartupField('browser bridge status', () => bridgeStatus()),
    update: updateStatus(),
    desktopAccess: getMacOSDesktopAccess(),
    settingsRecovered: settingsRecovered()
  };
}

/** Wraps a handler so a thrown error becomes a message the UI can show. */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true as const, data: await fn(payload) };
    } catch (err) {
      const message =
        err instanceof SandboxError || err instanceof z.ZodError
          ? err instanceof z.ZodError
            ? (err.issues[0]?.message ?? 'Invalid input')
            : err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false as const, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null, quitToInstall: () => void): void {
  registerWorkspaceTerminalIpc(getWindow);
  registerSkillsIpc(handle, getWindow);
  registerBrowserIpc({ handle, buildState });
  // A session row remains visible until its delete IPC resolves. Fence Trust while deletion is in flight so a second click cannot recreate permission after the row's durable revoke.
  const deletingSessionIds = new Set<string>();
  registerSettingsIpc({ handle, getWindow, buildState });
  registerSystemIpc({ handle, getWindow, buildState, quitToInstall });
  // Ignore stale state snapshots and destroyed windows before publishing renderer events.
  const push = (channel: string, ...args: unknown[]): void => {
    const target = getWindow();
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, ...args);
  };
  registerAutomationIpc({ handle, push });
  registerWorkspaceIpc({ handle, getWindow, buildState, push });
  registerSessionIpc({ handle, getWindow, push, deletingSessionIds });
  configureInputDelivery({
    recoveryAllowed: recoveryInputAllowed,
    callsHoldRecovery: recoveryHeldByCalls,
    activity: sessionInputActivity,
    wakeDecision: async (entry, signal) => {
      if (!entry.decisionProvider || !entry.decisionConversationId) {
        throw new Error('The saved decision has no provider identity. Restart it from the chat.');
      }
      signal.throwIfAborted();
      if (!await startBridge()) throw new Error('The browser bridge could not start');
      signal.throwIfAborted();
      await deliverProviderDecision(entry, signal);
    },
    bindHelper: async (conversationId, fromSessionId) => {
      const source = fromSessionId ? await getSession(fromSessionId) : null;
      if (source?.conversationId === conversationId || source?.chatIds.includes(conversationId)) return;
      await noteChatOrigin(conversationId, { kind: 'helper', fromSessionId, agentId: null, task: '' });
    },
    trustOpening: async (sessionId, conversationId) => {
      // Composer openings use the same deletion/rebind fence as an explicit Trust click. The second tombstone check and synchronous queue admission ensure Delete either wins before this grant or durably revokes it afterwards; no orphan permission can survive the row.
      if (deletingSessionIds.has(sessionId)) return false;
      return withSessionMutationFence(sessionId, async (summary) => {
        if (deletingSessionIds.has(sessionId) || summary.conversationId !== conversationId || summary.origin?.kind === 'worker') return false;
        await setChatsTrusted([conversationId], true);
        return true;
      });
    },
    changed: () => push('session:changed'),
    recordDelivered: (entry, anchorCommitted) => getConfig().sessions.record ? recordDeliveredInput(entry, anchorCommitted) : Promise.resolve(true),
    prepareText: async (entry, limits, authored) => {
      const control = entry.conversationId ? goalSwitchFor(entry.conversationId) : getConfig().goal;
      const mode = entry.automation ?? (control.enabled ? control.mode : 'off');
      const text = mode === 'goal' && goalBackendFor('goal') === 'templates' && !entry.text.includes(OFFLINE_GOAL_MARKER_INSTRUCTION)
        ? entry.text + OFFLINE_GOAL_MARKER_INSTRUCTION : entry.text;
      // Only the opening user input owns executor setup. Existing chats, queued checkpoints and automatic continuations already have their instructions.
      return (entry.opening || !entry.sessionId) && !entry.conversationId && !entry.finishOwner && entry.mode !== 'finish'
        ? prepareSessionPrompt(text, entry, limits, authored)
        : !entry.finishOwner && entry.purpose !== 'decision' ? prepareSkillFollowup(text, authored, limits, entry) : text;
    },
    applyAutomation: async (conversationId, automation, phase, objective, loopAfterTurn) => {
      // This message supersedes the old final; never pick that old final up merely because the composer enabled Goal for the next turn.
      const mode = automation === 'off' ? goalSwitchFor(conversationId).mode : automation;
      // Reserve switch ordering immediately, before awaiting another ledger write. A user Off arriving during persistence must remain later than this attempt.
      const switchWrite = setGoalSwitchNow(conversationId, mode, automation !== 'off', loopAfterTurn);
      const [held] = await Promise.all([switchWrite, setGoalReplyActiveNow(conversationId, false)]);
      // A fresh chat can finish before its send ACK arrives. Its newest final is this message's own response, so it may be picked up after binding. Objective ownership transfers with delivery even if the user switched Off before the fresh chat acquired its identity. The saved Off row remains the execution authority; retaining authored text must never imply reactivation.
      if (objective !== undefined) await setGoalObjectiveNow(conversationId, objective);
      const live = goalSwitchFor(conversationId);
      if (phase === 'after-send' && held.enabled && live.enabled && live.mode === held.mode) await setGoalReplyActiveNow(conversationId, true);
    }
  });

  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation !== statePushGeneration) return;
      push('state:changed', state);
    });
  };
  onBridgeChange(pushState);
  // Draft stages belong to session controls; state:changed only refreshes settings.
  onGoalChange(() => push('session:changed'));
  onUpdateChange(pushState);
  onMacOSDesktopAccessChange(pushState);
  onLog((entry) => push('log:entry', entry));
  // Recorder pushes name their exact transcript owners; payload-less pushes are catalog/control only.
  onSessionChange(change => push('session:changed', change));
  onBackgroundExecChange(() => push('sessions:backgroundExecChanged'));
  onSwarmChange(() => push('swarm:changed', swarmState()));
}
