import { app, nativeTheme } from 'electron';
import { z } from 'zod';
import { browserExtensionRequired } from '../../../contracts/types.js';
import { UI_LANGUAGES } from '../../../contracts/ui-language.js';
import { APP_VERSION } from '../../infrastructure/settings/version.js';
import { getConfig, updateConfig } from '../../infrastructure/settings/config.js';
import { setStopNoticeTranslations } from '../../infrastructure/desktop-shell/stuck-notice.js';
import { setMainTextTranslations } from '../../infrastructure/settings/main-texts.js';
import { isEncryptionAvailable, setSecret } from '../../infrastructure/settings/secrets.js';
import { bridgePortSelection } from '../../domains/browser/bridge-ports.js';
import { clearAllGoalSwitches, retireGoalDrafts } from '../../domains/automation/goal.js';
import { pauseSwarmForDisable, persistAgentAuthorityNow } from '../../domains/automation/agents.js';
import { publishBridgePortChange, startBridge, stopBridge, cancelWorkerCommands } from '../../domains/browser/bridge.js';
import { cancelFinishInputs } from '../../domains/sessions/input/input.js';
import { syncIntegratedBrowser } from '../../domains/browser/embedded/selection.js';
import { wakeBrowserWork } from '../../domains/browser/browser-wake.js';
import { applyLoginStartup } from '../../infrastructure/desktop-shell/window-lifecycle.js';
import { startControlApi, stopControlApi } from '../../infrastructure/local-api/control-api.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from '../../infrastructure/desktop-shell/window-layout.js';
import { mergeSettings, settingsSave } from './settings-contract.js';
import type { IpcRouteContext } from './types.js';

export function registerSettingsIpc({ handle, getWindow, buildState }: Pick<IpcRouteContext, 'handle' | 'getWindow' | 'buildState'>): void {
  handle('settings:save', async (payload) => {
    const request = settingsSave.parse(payload);
    const before = getConfig();
    const next = await updateConfig(async config => {
      if (request.patch.ui.browserBridgePort !== undefined &&
          request.patch.ui.browserBridgePort !== (request.base.ui.browserBridgePort ?? 'auto') &&
          bridgePortSelection().overridden) {
        throw new Error('Browser bridge port is controlled by NEURAFLOK_BRIDGE_PORTS.');
      }
      const proposed = { ...config, ...mergeSettings(config, request.base, request.patch) };
      // If an earlier Off retirement failed, On must retry it before admission.
      if (!config.ui.finishTool && proposed.ui.finishTool) await cancelFinishInputs(false);
      else if (!config.goal.impulseMinutes && (proposed.goal.impulseMinutes ?? 0) > 0) await cancelFinishInputs(true);
      return proposed;
    }, async (published, previous) => {
      if (previous.ui.finishTool && !published.ui.finishTool) await cancelFinishInputs(false);
      else if ((previous.goal.impulseMinutes ?? 0) > 0 && !published.goal.impulseMinutes) await cancelFinishInputs(true);
    }, publishBridgePortChange);
    // Renderer palette changes are immediate, so keep OS/Electron-owned chrome in lock-step too. Without this, selecting Dark on macOS left the title bar, menus and file picker in the system theme until restart (and startup still defaulted to system before index.ts applies it).
    nativeTheme.themeSource = next.ui.theme;
    if (process.platform === 'win32') getWindow()?.setTitleBarOverlay(titleBarOverlayForTheme(next.ui.theme, next.ui.appearance));
    // BrowserWindow's native backing color is fixed at construction unless updated explicitly. Keep it in lock-step too: the default macOS application menu exposes Reload, and after a live theme switch an old opposite background otherwise flashes behind the renderer while it paints again. This is also the color Electron shows during any later renderer reload/failure.
    getWindow()?.setBackgroundColor(windowBackgroundForTheme(next.ui.theme, next.ui.appearance));
    if (
      before.goal.enabled !== next.goal.enabled ||
      // The mode is authority too: a draft started as a gate must not be typed after the user asked for a loop, and a loop draft must not be typed after they asked for a gate.
      before.goal.mode !== next.goal.mode ||
      before.goal.model !== next.goal.model ||
      before.goal.backend !== next.goal.backend ||
      before.goal.loopBackend !== next.goal.loopBackend ||
      JSON.stringify(before.providers.api) !== JSON.stringify(next.providers.api) ||
      before.goal.reasoning !== next.goal.reasoning ||
      before.goal.prompt !== next.goal.prompt ||
      before.goal.objectivePrompt !== next.goal.objectivePrompt ||
      before.goal.loopPrompt !== next.goal.loopPrompt
    ) {
      retireGoalDrafts(before.goal.enabled && !next.goal.enabled);
    }
    // The app-wide switch going off is the master stop, and has to actually stop things. Chats carry their own Goal/Loop answer now, so without this the one control that looks like it governs everything would govern only the chats that never disagreed with it — and a loop somebody wanted stopped would go on running with nowhere obvious to switch it off. Turning it *on* deliberately does not reach into a chat that has said no.
    if (before.goal.enabled && !next.goal.enabled) clearAllGoalSwitches();
    // Order matters, and it used to be wrong. Pausing the run and withdrawing worker browser commands has to happen while the bridge can still cancel those transports; stopping the bridge first left queued worker/revival commands behind for a later restart to deliver.
    let authorityPersistError: Error | null = null;
    if (!next.multiAgent.enabled) {
      // Off pauses execution; it is not the destructive Clear swarm action. Preserve every prime-owned worker history so re-enable/restart can still show and revive exact chats.
      pauseSwarmForDisable();
      cancelWorkerCommands('multi-agent mode was turned off');
      try {
        if (!(await persistAgentAuthorityNow())) {
          throw new Error('Multi-agent teardown has no immediate durable persistence sink.');
        }
      } catch (error) {
        authorityPersistError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // Recording, workers and direct browser tools share the same extension transport. Startup and settings saves use one eligibility rule.
    if (browserExtensionRequired(next)) await startBridge();
    else await stopBridge();
    if (before.ui.chatBrowser !== next.ui.chatBrowser) await syncIntegratedBrowser();
    if (before.capabilities.screen !== next.capabilities.screen || before.capabilities.control !== next.capabilities.control || before.readOnly !== next.readOnly) wakeBrowserWork('browser-control');
    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on, but the UI must not be told the pause was safely accepted when its retained authority snapshot failed to cross disk. Startup with the feature off restores and canonicalizes that same history instead of deleting it. Login registration is an independent OS preference. Cosmetic saves do not rewrite it, and its failure cannot interrupt permission publication or Goal/worker teardown.
    let loginStartupError: unknown;
    if ((before.ui.startAtLogin === true) !== (next.ui.startAtLogin === true)) {
      try { applyLoginStartup(app, next.ui.startAtLogin === true); }
      catch (error) { loginStartupError = error; }
    }
    // The local control API is independent in the same way: only an actual change starts or stops it, and a listener that cannot bind never undoes the rest of the save.
    let controlApiError: unknown;
    if (before.controlApi.enabled !== next.controlApi.enabled) {
      try { await (next.controlApi.enabled ? startControlApi() : stopControlApi()); }
      catch (error) { controlApiError = error; }
    }
    // The listener reads this switch on every request, so a flip needs no restart; it is logged.
    if (before.controlApi.allowActions !== next.controlApi.allowActions) {
      logInfo('control API: actions ' + (next.controlApi.allowActions ? 'allowed' : 'refused'));
    }
    if (authorityPersistError) throw authorityPersistError;
    if (loginStartupError) throw loginStartupError;
    if (controlApiError) throw controlApiError;
    return buildState();
  });

  handle('ui:language', async payload => {
    // The renderer owns the choice; the main process keeps it for the browser extension.
    const language = z.enum(UI_LANGUAGES).parse(payload);
    if (getConfig().ui.language !== language) await updateConfig(config => ({ ...config, ui: { ...config.ui, language } }));
  });
  handle('ui:whatsNewSeen', async () => {
    // Only this version can be recorded; the renderer cannot write another one.
    if (getConfig().ui.lastSeenVersion !== APP_VERSION) await updateConfig(config => ({ ...config, ui: { ...config.ui, lastSeenVersion: APP_VERSION } }));
  });
  handle('ui:stopNoticeTexts', async payload => {
    // The renderer's catalogs translate stopped-chat notices; text is bounded and allowlisted.
    setStopNoticeTranslations(z.record(z.string().max(200), z.string().max(400)).refine(value => Object.keys(value).length <= 16).parse(payload));
  });
  handle('ui:mainTexts', async payload => {
    // The tray menu and Session finish notice in the interface language; bounded and allowlisted.
    setMainTextTranslations(z.record(z.string().max(200), z.string().max(200)).refine(value => Object.keys(value).length <= 32).parse(payload));
  });
  /** Stores one of the defined provider keys by name. The name is an enum rather than a string, so the renderer can choose *which* credential it is writing but cannot name a slot nobody defined — and the value still only ever travels inwards. Nothing reads a key back out over IPC; the state carries a boolean. */
  handle('secret:set', async (payload) => {
    const { value, key } = z
      .object({
        value: z.string().max(16_000),
        key: z.enum(['openaiChatApiKey', 'openRouterApiKey', 'customProviderApiKey', 'customProviderHeaders'])
      })
      .parse(payload);
    if (key !== 'customProviderHeaders' && value.length > 500) throw new Error('API keys cannot exceed 500 characters.');
    if (key === 'customProviderHeaders' && value !== '') {
      let headers: unknown;
      try { headers = JSON.parse(value); } catch { throw new Error('Additional API headers must be valid JSON.'); }
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 24) {
        throw new Error('Additional API headers must be a JSON object with at most 24 entries.');
      }
      const authHeader = getConfig().providers.api.authHeader?.trim().toLowerCase() || 'authorization';
      const forbidden = new Set(['authorization', 'proxy-authorization', 'content-type', 'host', 'cookie', 'set-cookie', authHeader]);
      for (const [name, headerValue] of Object.entries(headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.has(name.toLowerCase()) ||
            typeof headerValue !== 'string' || headerValue.length > 2000 || /[\r\n\u0000]/.test(headerValue)) {
          throw new Error(`Additional API header ${name.slice(0, 80)} is invalid or reserved.`);
        }
      }
    }
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    await setSecret(key, value);
    const activeGoalKey = getConfig().providers.api.kind === 'custom' ? 'customProviderApiKey'
      : getConfig().providers.api.kind === 'openai' ? 'openaiChatApiKey' : 'openRouterApiKey';
    if (key === activeGoalKey || (key === 'customProviderHeaders' && getConfig().providers.api.kind === 'custom')) retireGoalDrafts();
    const what = key === 'openRouterApiKey' ? 'OpenRouter key' : key === 'openaiChatApiKey' ? 'OpenAI model key'
      : 'custom provider key';
    logInfo(value.trim() === '' ? `${what} cleared` : `${what} stored`);
    return buildState();
  });

  /** The OpenRouter catalogue, newest first, one page at a time. Fetched here rather than in the renderer for the same reason every other network call is: the key that authorises it never crosses this boundary. The page size is the module's own, so the renderer cannot ask for the whole catalogue in one call. */

}
