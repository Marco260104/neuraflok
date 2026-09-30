import { onLanguageChange, t } from '../../shared/i18n.js';
import { STOP_NOTICE_TEXTS } from '../../../contracts/stop-notice.js';

/** Translates the exact stopped-chat notice texts and publishes them to the main process. */
export function stopNoticeTexts(): Record<(typeof STOP_NOTICE_TEXTS)[number], string> {
  return {
    'A chat stopped': t('A chat stopped'),
    'Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.':
      t('Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.'),
    'Its last turn failed and nothing followed. Send a message there to start a fresh turn.':
      t('Its last turn failed and nothing followed. Send a message there to start a fresh turn.'),
    'Recovery stopped': t('Recovery stopped'),
    "The browser did not pick up this chat's repair, so the app stopped retrying. Open its tab again and recovery resumes.":
      t("The browser did not pick up this chat's repair, so the app stopped retrying. Open its tab again and recovery resumes.")
  };
}

/** Publishes now and after every language change; a failed hand-over leaves English notices. */
export function publishStopNoticeTexts(send: (texts: Record<string, string>) => unknown): void {
  const publish = () => { try { void Promise.resolve(send(stopNoticeTexts())).catch(() => undefined); } catch { /* English stays. */ } };
  publish();
  onLanguageChange(publish);
}
