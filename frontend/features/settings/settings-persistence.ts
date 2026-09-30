import type { AppearanceSettings } from '../../../contracts/appearance-settings.js';
import type { BrowserBridgePort } from '../../../contracts/browser/bridge.js';
import type { AppApi, SettingsPatch } from '../../../backend/preload/index.js';
import { isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import type { AppState, Capability, ChatBrowser } from '../../../contracts/types.js';
import { DESKTOP_CAPABILITIES, WRITE_CAPABILITIES } from '../../../contracts/types.js';
import { $, run, toast } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import { chatSettingsPatch } from '../chat/chat.js';

interface Runtime {
  api: AppApi;
  getState: () => AppState | null;
  isApplying: () => boolean;
  readCommandAllowlist: () => SettingsPatch['commandAllowlist'] | null;
  apply: (state: AppState) => void;
  refresh: () => Promise<void>;
}

export function createSettingsPersistence(runtime: Runtime) {
  const { api, getState, isApplying, readCommandAllowlist, apply, refresh } = runtime;
  // Save section.

  // A settings save is a full snapshot, even though the main process applies it as a patch. Capture each requested snapshot immediately, but derive it from the latest *requested* state rather than only the latest acknowledged state. Then serialize IPC delivery. This handles both halves of the race: a later save cannot inherit stale readOnly/theme, and the first save's reply cannot repaint a control before the later save has captured what the user changed there.
  let settingsSaveQueue: Promise<void> = Promise.resolve();
  let requestedSettings: SettingsPatch | null = null;

  function save(over: { readOnly?: boolean; theme?: 'light' | 'dark'; appearance?: AppearanceSettings } = {}): Promise<void> {
    const state = getState();
    if (isApplying() || !state) return Promise.resolve();

    const previous: AppState['config'] = requestedSettings
      ? { ...state.config, ...requestedSettings }
      : state.config;
    const commandAllowlist = readCommandAllowlist();
    if (!commandAllowlist) return Promise.resolve();
    const capabilities = { ...previous.capabilities };
    for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
      const capability = input.dataset.cap as Capability;
      // Unsupported hosts hide Desktop automation while preserving any choices stored in this config. A hidden disabled checkbox is presentation, not a user edit: copying its forced-false value into every unrelated settings save would erase those choices merely because the config was opened on another OS.
      if (!(state.platform?.desktopAutomation ?? true) && DESKTOP_CAPABILITIES.includes(capability) && capability !== 'screen' && capability !== 'control') continue;
      capabilities[capability] = input.checked;
    }
    const readOnly = over.readOnly ?? previous.readOnly;
    const chatPatch = chatSettingsPatch(previous);
    const selectedBridgePort = $<HTMLSelectElement>('browserBridgePort').value;
    const patch: SettingsPatch = {
      capabilities,
      readOnly,
      commandAllowlist,
      ui: {
        ...previous.ui,
        chatBrowser: $<HTMLSelectElement>('chatBrowser').value as ChatBrowser,
        finishTool: $<HTMLInputElement>('finishTool').checked,
        planBackend: $<HTMLSelectElement>('planBackend').value as 'web' | 'api',
        finishLeadMinutes: Number($<HTMLSelectElement>('finishLeadMinutes').value),
        backgroundChats: $<HTMLInputElement>('backgroundChats').checked,
        browserBridgePort: (selectedBridgePort === 'auto' ? 'auto' : Number(selectedBridgePort)) as BrowserBridgePort,
        chatExecutor: $<HTMLSelectElement>('chatExecutor').value === 'api' ? 'api' : 'web',
        webProvider: isWebProviderId($<HTMLSelectElement>('webProvider').value)
          ? $<HTMLSelectElement>('webProvider').value as WebProviderId
          : 'deepseek',
        autoContinue: $<HTMLInputElement>('autoContinue').checked,
        browserOnly: $<HTMLInputElement>('browserOnly').checked,
        autoSelectSkills: $<HTMLInputElement>('autoSelectSkills').checked,
        startAtLogin: $<HTMLInputElement>('startAtLogin').checked,
        minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
        developerMode: $<HTMLInputElement>('developerMode').checked,
        followOutput: $<HTMLInputElement>('followOutput').checked,
        mentionCore: $<HTMLInputElement>('mentionCore').checked,
        privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
        theme: over.theme ?? previous.ui.theme,
        appearance: over.appearance ?? previous.ui.appearance
      },
      controlApi: { enabled: $<HTMLInputElement>('controlApiEnabled').checked, allowActions: $<HTMLInputElement>('controlApiAllowActions').checked },
      ...chatPatch
    };
    requestedSettings = patch;

    const work = settingsSaveQueue.then(
      () => saveSnapshot(patch, previous),
      () => saveSnapshot(patch, previous)
    );
    settingsSaveQueue = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  }

  async function saveSnapshot(patch: SettingsPatch, previous: AppState['config']): Promise<void> {
    const toolSurfaceChanged =
      previous.multiAgent.enabled !== patch.multiAgent.enabled ||
      (Object.keys(patch.capabilities) as Capability[]).some((cap) => {
        const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
        const after = patch.capabilities[cap] && !(patch.readOnly && WRITE_CAPABILITIES.includes(cap));
        return before !== after;
      });
    const base: SettingsPatch = {
      capabilities: previous.capabilities,
      readOnly: previous.readOnly,
      commandAllowlist: previous.commandAllowlist,
      ui: previous.ui,
      sessions: previous.sessions,
      compaction: previous.compaction,
      providerTools: previous.providerTools ?? { instructions: '' },
      controlApi: previous.controlApi ?? { enabled: false, allowActions: false },
      multiAgent: previous.multiAgent,
      goal: previous.goal
    };
    const next = await run(api.saveSettings(patch, base));
    // Retire this request before repaint, while a newer queued preference still wins.
    if (requestedSettings === patch) requestedSettings = null;
    if (next) {
      apply(next);
      if (previous.multiAgent.enabled && !patch.multiAgent.enabled) {
        // A cached snapshot keeps offering the `agents` tool until the connector is reloaded. Say so plainly rather than letting it look sticky.
        toast(t("Multi-agent is off. Start a new provider chat to apply the updated tool set."));
      } else if (toolSurfaceChanged) {
        toast(t("Tools changed. Start a new provider chat to load the updated tool set."));
      }
    } else {
      await refresh();
      const state = getState();
      // A rejected select remains focused. Restore it even though ordinary pushes protect dirty controls, unless a later save explicitly requested a different port. Unchanged queued snapshots keep their original base so main's three-way merge cannot retry this rejection.
      if (state && (!requestedSettings || requestedSettings.ui.browserBridgePort === patch.ui.browserBridgePort)) {
        $<HTMLSelectElement>('browserBridgePort').value = String(state.config.ui.browserBridgePort ?? 'auto');
      }
      // The same for the control API switches: a box that stayed ticked after a failed save would send its value again with the next unrelated save, and grant what was never saved.
      if (state && (!requestedSettings || requestedSettings.controlApi?.allowActions === patch.controlApi?.allowActions)) {
        $<HTMLInputElement>('controlApiAllowActions').checked = state.config.controlApi?.allowActions === true;
      }
      if (state && (!requestedSettings || requestedSettings.controlApi?.enabled === patch.controlApi?.enabled)) {
        $<HTMLInputElement>('controlApiEnabled').checked = state.config.controlApi?.enabled === true;
      }
    }
  }

  return { save, requestedSettings: () => requestedSettings };
}
