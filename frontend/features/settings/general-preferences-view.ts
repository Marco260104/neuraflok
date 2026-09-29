import type { AppState } from '../../../contracts/types.js';
import { $ } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type ApplyValue = (control: Control, next: string, previous?: string) => void;
type ApplyChecked = (control: HTMLInputElement, next: boolean, previous?: boolean) => void;

export function createGeneralPreferencesView(helpers: {
  applyValue: ApplyValue;
  applyChecked: ApplyChecked;
}) {
  return {
    paint(next: AppState, previousState: AppState | null): void {
      const { config } = next;

      helpers.applyValue(
        $<HTMLSelectElement>('chatBrowser'),
        config.ui.chatBrowser ?? 'integrated',
        previousState?.config.ui.chatBrowser ?? 'integrated'
      );
      $<HTMLSelectElement>('planBackend').value = config.ui.planBackend ?? 'web';
      helpers.applyChecked($<HTMLInputElement>('finishTool'), config.ui.finishTool === true, previousState?.config.ui.finishTool);
      helpers.applyValue(
        $<HTMLSelectElement>('finishLeadMinutes'),
        String(config.ui.finishLeadMinutes ?? 5),
        String(previousState?.config.ui.finishLeadMinutes ?? 5)
      );
      $<HTMLSelectElement>('finishLeadMinutes').disabled = config.ui.finishTool !== true;
      helpers.applyChecked($<HTMLInputElement>('backgroundChats'), config.ui.backgroundChats === true, previousState?.config.ui.backgroundChats);

      const bridgePortControl = $<HTMLSelectElement>('browserBridgePort');
      helpers.applyValue(
        bridgePortControl,
        String(config.ui.browserBridgePort ?? 'auto'),
        String(previousState?.config.ui.browserBridgePort ?? 'auto')
      );
      bridgePortControl.disabled = next.bridge.portOverridden === true;
      ui($('browserBridgePortHint'), 'textContent', () => next.bridge.portOverridden
        ? t('Controlled by NEURAFLOK_BRIDGE_PORTS. Change the environment override to choose a port here.')
        : t('Auto uses the first available port. A fixed port must be available.'));

      helpers.applyChecked($<HTMLInputElement>('autoContinue'), config.ui.autoContinue !== false, previousState?.config.ui.autoContinue);
      helpers.applyChecked($<HTMLInputElement>('browserOnly'), config.ui.browserOnly === true, previousState?.config.ui.browserOnly);
      helpers.applyChecked($<HTMLInputElement>('autoSelectSkills'), config.ui.autoSelectSkills === true, previousState?.config.ui.autoSelectSkills);
      $('startAtLoginRow').hidden = next.loginStartupAvailable !== true;
      $<HTMLInputElement>('startAtLogin').disabled = next.loginStartupAvailable !== true;
      helpers.applyChecked($<HTMLInputElement>('startAtLogin'), config.ui.startAtLogin === true, previousState?.config.ui.startAtLogin);
      helpers.applyChecked($<HTMLInputElement>('developerMode'), config.ui.developerMode === true, previousState?.config.ui.developerMode);
      helpers.applyChecked($<HTMLInputElement>('followOutput'), config.ui.followOutput !== false, previousState?.config.ui.followOutput);
      helpers.applyChecked($<HTMLInputElement>('mentionCore'), config.ui.mentionCore !== false, previousState?.config.ui.mentionCore);
      helpers.applyChecked($<HTMLInputElement>('controlApiEnabled'), config.controlApi?.enabled === true, previousState?.config.controlApi?.enabled);
      helpers.applyChecked($<HTMLInputElement>('controlApiAllowActions'), config.controlApi?.allowActions === true, previousState?.config.controlApi?.allowActions);
      $<HTMLInputElement>('controlApiAllowActions').disabled = config.controlApi?.enabled !== true;
      helpers.applyChecked($<HTMLInputElement>('minimizeToTray'), config.ui.minimizeToTray, previousState?.config.ui.minimizeToTray);
      helpers.applyChecked($<HTMLInputElement>('privacyScreenshots'), config.ui.privacyScreenshots, previousState?.config.ui.privacyScreenshots);
      $('privacyScreenshotsSetting').hidden = !(next.platform?.desktopAutomation ?? true);
      ui($('minimizeToTrayCopy'), 'textContent', () => next.platform?.family === 'macos'
        ? t('Hide the window to the menu bar when closed')
        : t('Keep running in the tray when closed'));
    }
  };
}
