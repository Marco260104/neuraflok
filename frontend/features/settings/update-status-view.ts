import type { AppState } from '../../../contracts/types.js';
import { browserExtensionRequired, isNewer } from '../../../contracts/types.js';
import { $, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

type UpdateTone = 'ok' | 'work' | 'bad';

export function createUpdateStatusView() {
  let announced = false;

  function summary({ bridge, update, config }: AppState): { text: string; tone: UpdateTone; notice: boolean; extensionAction: string | null } | null {
    const stale = bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion)
      ? bridge.extensionVersion
      : null;
    const missing = !stale && bridge.running && !bridge.present && browserExtensionRequired(config);
    if (!stale && !missing && !update.latest && update.stage === 'idle' && !update.checkedAt) return null;
    const lines: string[] = [];
    let tone: UpdateTone = 'work';
    if (update.latest) {
      lines.push(
        update.stage === 'checking'
          ? t('Checking for the latest update…')
          : update.stage === 'ready'
            ? t('NEURAFLOK {0} is downloaded and ready. Install it now, or it installs the next time you quit.', [update.latest])
            : update.stage === 'downloading'
              ? t('NEURAFLOK {0} is downloading. Keep working; you can install it when it lands.', [update.latest])
              : update.stage === 'failed'
                ? t('NEURAFLOK {0} could not be downloaded: {1}.', [update.latest, update.error ?? t('the download stopped')])
                : t('NEURAFLOK {0} is out. This installation has to be updated by hand.', [update.latest])
      );
      if (update.stage === 'failed') tone = 'bad';
    } else if (update.stage === 'failed') {
      lines.push(t('Could not check for a newer version: {0}.', [update.error ?? t('the check stopped')]));
      tone = 'bad';
    } else if (update.stage === 'checking') {
      lines.push(t('Checking for a newer version…'));
    } else if (update.stage === 'unconfigured') {
      lines.push(t('Automatic updates are not configured for this NEURAFLOK build.'));
    } else if (!stale && !missing) {
      const extension = bridge.present && bridge.extensionVersion ? t(' · extension {0}', [bridge.extensionVersion]) : '';
      lines.push(t('Up to date! NEURAFLOK {0}{1}', [update.current, extension]));
      tone = 'ok';
    }
    if (stale) {
      lines.push(
        t('Update your browser extension: {0} → {1}. ', [stale, update.current]) +
          t('Restart NEURAFLOK to load its updated companion.')
      );
      tone = 'bad';
    }
    if (missing) {
      lines.push(t('Browser extension not connected. Open Setup to connect the NEURAFLOK companion.'));
      tone = 'bad';
    }
    return {
      text: lines.join(' '),
      tone,
      notice: Boolean(update.latest || stale || missing),
      extensionAction: stale ? t('Update extension') : missing ? t('Check extension') : null
    };
  }

  function paint(next: AppState): void {
    const value = summary(next);
    const notice = $('updateNotice');
    const line = $('updateLine');
    const extensionButton = document.getElementById('updateExtension');
    const getButton = document.getElementById('updateGet');
    const installButton = document.getElementById('updateInstall');
    const installNowButton = document.getElementById('installUpdate');
    if (!value) {
      if (notice) notice.hidden = true;
      if (line) line.hidden = true;
      if (extensionButton) extensionButton.hidden = true;
      return;
    }
    const { update } = next;
    ui($('updateText'), 'textContent', () => summary(next)?.text ?? '');
    if (extensionButton) {
      extensionButton.hidden = !value.extensionAction;
      ui(extensionButton, 'textContent', () => summary(next)?.extensionAction ?? t('Update extension'));
    }
    if (getButton) getButton.hidden = !update.latest || update.stage === 'checking' || update.stage === 'downloading' || update.stage === 'ready';
    const installable = update.stage === 'ready';
    if (installButton) installButton.hidden = !installable;
    if (installNowButton) installNowButton.hidden = !installable;
    if (notice) notice.hidden = !value.notice;
    if (line) {
      ui(line, 'textContent', () => summary(next)?.text ?? '');
      line.className = `upline${value.tone === 'ok' ? ' is-ok' : value.tone === 'bad' ? ' is-bad' : ''}`;
      line.hidden = false;
    }
    if (!announced && update.stage !== 'checking' && update.stage !== 'downloading') {
      announced = true;
      toast(value.text);
    }
  }

  return { paint };
}
