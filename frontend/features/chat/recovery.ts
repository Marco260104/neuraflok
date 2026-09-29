import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import { el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

type RecoveryNext = NonNullable<RecoveryCountdown['next']>;

const NEXT_LABEL: Record<RecoveryNext, () => string> = {
  queue: () => t('Queued message'),
  goal: () => t('Goal'),
  loop: () => t('Loop'),
  continue: () => t('Automatic Continue')
};

const RELOAD_REASONS = new Set<RecoveryCountdown['kind']>(['unattributed', 'silence', 'assistant-error']);

function labelForNext(countdown: RecoveryCountdown): string {
  switch (countdown.kind) {
    case 'pickup-stopped': return t('Recovery stopped');
    case 'pickup': return t('Waiting for delivery');
    case 'post-reload': return countdown.generating ? t('Reloaded · turn still marked generating') : t('Reloaded');
    case 'thinking-failed': return t('Thinking failed');
    default: return t('Turn still marked generating · extra wait');
  }
}

function labelWithoutNext(countdown: RecoveryCountdown): string {
  switch (countdown.kind) {
    case 'unattributed': return t('Unattributed call');
    case 'unattributed-wait': return t('Unattributed activity · awaiting attribution');
    case 'assistant-error': return t('Interrupted response');
    case 'tab-recovery': return t('Browser tab recovery');
    case 'silence': return t('No recent activity');
    case 'post-reload': return t('Reloaded · waiting for activity');
    case 'thinking-failed': return t('Thinking failed · waiting for activity');
    default: return t('Turn still marked generating · extra wait');
  }
}

function labelFor(countdown: RecoveryCountdown): string {
  const label = countdown.next ? labelForNext(countdown) : labelWithoutNext(countdown);
  return countdown.next ? t('{0} · next: {1}', [label, NEXT_LABEL[countdown.next]()]) : label;
}

function titleFor(countdown: RecoveryCountdown): string {
  if (countdown.kind === 'pickup-stopped') {
    return t('The browser did not collect the pending step after {0} automatic reload attempts. Its original queued input or Goal obligation remains saved. NEURAFLOK will not reload this chat for this step again; open the chat to continue manually.', [String(countdown.attempts ?? 3)]);
  }
  if (countdown.kind === 'native-busy' || countdown.generating) {
    return t('Delivery was deferred because the turn is still marked generating. This is the remaining extra wait, not a new reload timer. Fresh work or a final answer cancels recovery.');
  }
  if (countdown.next === 'continue') {
    return t('New activity, a final answer or your Stop cancels automatic Continue. Stop is used only if the provider is still generating.');
  }
  switch (countdown.kind) {
    case 'unattributed-wait': return t('An attributed MCP call clears this chat. The five-minute window starts with the first unattributed call.');
    case 'unattributed': return t('This chat is a possible source. An attributed MCP call cancels its reload.');
    case 'silence': return t('New activity cancels this countdown.');
    case 'assistant-error': return t("The provider page lost this answer's live stream. The answer may still be running: the reload reconnects the page without stopping it.");
    default: return t('New activity cancels recovery. The countdown shows the next check or delivery attempt.');
  }
}

function timerText(countdown: RecoveryCountdown, seconds: number, clock: string): string {
  if (countdown.kind === 'pickup-stopped') return t('Stopped after {0} attempts', [String(countdown.attempts ?? 3)]);
  if (countdown.kind === 'pickup') return seconds ? t('Reload in {0}', [clock]) : t('Reload pending…');
  if (countdown.next === 'continue') return seconds ? t('Continue in {0}', [clock]) : t('Preparing Continue…');
  if (countdown.kind === 'tab-recovery') return seconds ? t('Recovery in {0}', [clock]) : t('Recovery pending…');
  if (RELOAD_REASONS.has(countdown.kind) || countdown.reload) return seconds ? t('Reload in {0}', [clock]) : t('Reload pending…');
  return seconds ? t('Check in {0}', [clock]) : t('Checking for activity…');
}

function renderRow(countdown: RecoveryCountdown, actionFor?: (countdown: RecoveryCountdown) => HTMLElement | null): HTMLElement {
  const row = el('div', 'recovery-notice');
  const label = el('span', 'queue-label', () => labelFor(countdown));
  ui(row, 'title', () => titleFor(countdown));
  const timer = el('span', 'recovery-countdown');
  timer.setAttribute('role', 'timer');
  timer.setAttribute('aria-live', 'off');
  row.append(icon('i-pulse'), label, timer);
  const action = actionFor?.(countdown);
  if (action) row.append(action);
  return row;
}

function updateTimers(host: HTMLElement, countdowns: readonly RecoveryCountdown[], now: number): void {
  host.hidden = countdowns.every(countdown => (countdown.visibleAt ?? 0) > now);
  const timers = host.querySelectorAll<HTMLElement>('.recovery-countdown');
  timers.forEach((timer, index) => {
    const countdown = countdowns[index];
    if (!countdown) return;
    timer.closest<HTMLElement>('.recovery-notice')!.hidden = (countdown.visibleAt ?? 0) > now;
    const seconds = Math.max(0, Math.ceil((countdown.deadline - now) / 1000));
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const text = timerText(countdown, seconds, clock);
    if (timer.textContent !== text) timer.textContent = text;
  });
}

export function renderRecoveryCountdowns(host: HTMLElement, countdowns: readonly RecoveryCountdown[], now = Date.now(),
  actionFor?: (countdown: RecoveryCountdown) => HTMLElement | null): boolean {
  const key = JSON.stringify(countdowns);
  if (!countdowns.length) { delete host.dataset.countdowns; return false; }
  if (host.dataset.countdowns !== key) {
    host.replaceChildren(...countdowns.map(countdown => renderRow(countdown, actionFor)));
    host.dataset.countdowns = key;
  }
  updateTimers(host, countdowns, now);
  return true;
}
