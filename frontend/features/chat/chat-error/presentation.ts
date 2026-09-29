import type { SessionEvent } from '../../../../contracts/session.js';
import { t } from '../../../shared/i18n.js';
import type { ChatErrorEvidence } from './history-evidence.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;

function basePresentation(error: ChatError) {
  const text = error.message.text.trim();
  const thinking = text === 'Thinking failed';
  const stalled = text.startsWith('No visible progress for ten minutes.');
  const title = thinking ? t('Thinking failed') : stalled ? t('Response stalled') : t('The provider reported a problem');
  const message = thinking
    ? t('The provider page reported a failure. This does not prove the work stopped.')
    : stalled
      ? t('No visible progress for ten minutes. The app could not confirm that this turn finished.')
      : error.message.text;
  const next = error.blocking === true
    ? t('Wait until the provider allows requests again, then retry. Reloading cannot remove this limit.')
    : thinking
      ? t('You can send a follow-up. Automatic recovery, when allowed, refreshes the page and waits five minutes before a queued continuation; new work postpones it.')
      : error.recoverable === true || stalled
        ? t('The app will try to refresh this provider page when recovery is eligible. A refresh does not resend your message. If it stays stuck, open the provider and check the page before retrying.')
        : t('Open this provider session and check the error. If your message is already there, do not send it again; otherwise retry when the page is ready.');

  return { title, message, next, thinking, stalled };
}

function repairGuidance(error: ChatError, evidence: ChatErrorEvidence, thinking: boolean, errorReloaded: boolean): string {
  const repair = evidence.repair;
  if (repair && error.blocking !== true) {
    const followUp = thinking
      ? t('You can send a follow-up. After a confirmed refresh, automatic continuation waits five minutes and checks for new work before sending.')
      : errorReloaded
        ? t('We reload on an error only once per chat and turn. Further errors wait for tool calls to stop and the silence window before another reload.')
        : t('Queued messages still wait until sending is safe. If the session stays stuck, open the provider and check the page before retrying.');
    return `${repair.message.text} ${followUp}`;
  }

  if (errorReloaded && error.blocking !== true) {
    const policy = t('We reload on an error only once per chat and turn. Further errors wait for tool calls to stop and the silence window before another reload.');
    return `${t('This turn already received its automatic error reload.')} ${policy}`;
  }

  return '';
}

export function presentChatError(error: ChatError, evidence: ChatErrorEvidence) {
  const base = basePresentation(error);
  const resolved = evidence.completedPosition > evidence.continuedPosition;
  if (resolved) {
    return {
      title: t('Recovered after interruption'),
      message: base.message,
      resolved: true,
      reloaded: false,
      next: t('This turn later completed. You can continue with a new message.')
    };
  }

  const repair = evidence.repair;
  const reloaded = error.blocking !== true && !!repair && /^(?:Reloaded|Reopened) chat\b/.test(repair.message.text);
  const errorReloaded = evidence.previousErrorReload || (reloaded && repair?.message.text.endsWith('an interrupted response.'));
  const reloadPolicy = errorReloaded && error.blocking !== true;
  let next = repairGuidance(error, evidence, base.thinking, errorReloaded) || base.next;

  if (evidence.continuedPosition > 0) {
    next = repair || reloadPolicy
      ? `${next} ${t('Work continued after this notice. Queued messages still wait until sending is safe.')}`
      : t('Work continued after this notice. Automatic continuation waits for work to settle; the failed page alone does not trigger another message.');
  } else if (reloaded && reloadPolicy) {
    next += ` ${t('Queued messages still wait until sending is safe.')}`;
  }

  return {
    title: reloaded ? t('Chat automatically refreshed') : base.title,
    message: base.message,
    next,
    resolved: false,
    reloaded
  };
}
