import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { GoalWait } from '../../../contracts/automation/goal-progress.js';
import { goalErrorMessage } from '../../../contracts/goal-errors.js';
import type { TaskProgress } from '../../../contracts/automation/task-progress.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import { currentLanguage, t } from '../../shared/i18n.js';
import { $, el } from '../../shared/dom.js';

export type GoalProgressView = Omit<TaskProgress, 'phase'> & { phase: string; selection: number; inputId?: string };
export type GoalDraftPresentation = { stage: string; model: string; text: string; error: string | null };

export interface ChatGoalProgressRuntime {
  progress: GoalProgressView | null;
  selectionGeneration: number;
  pendingComposerInputs: readonly InputEntry[];
  controlledSessionId: string | null;
  controlledSelection: number;
  selectedId: string | null;
  finishGoalDraftView: GoalDraftPresentation | null;
  goalDraftView: GoalDraftPresentation | null;
  goalWaitView: GoalWait | null;
  controlledRecovery: readonly RecoveryCountdown[];
  goalReachedShown(): boolean;
  localizedGoalError(error: string): string;
  dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement;
  openSessionChat(id: string): Promise<unknown>;
}

export function localizedGoalError(error: string): string {
  const message = goalErrorMessage(error);
  const delivery = /^The helper prompt could not be delivered\. (.+)$/.exec(message);
  if (delivery) return t('The helper prompt could not be delivered. {0}', [delivery[1]!]);
  const http = /^The continuation provider rejected the request \(HTTP (\d{3})\)\. Check its status and the configured model or endpoint\.$/.exec(message);
  if (http) return t('The continuation provider rejected the request (HTTP {0}). Check its status and the configured model or endpoint.', [http[1]!]);
  const code = /^The continuation could not proceed\. Check the app diagnostics for details \(([^)]+)\)\.$/.exec(message);
  if (code) return t('The continuation could not proceed. Check the app diagnostics for details ({0}).', [code[1]!]);
  return t(message);
}

export function paintGoalProgress(runtime: ChatGoalProgressRuntime): void {
  let row = document.getElementById('goalLifecycle');
  if (!row) {
    row = el('div', 'queued-input');
    row.id = 'goalLifecycle';
    row.setAttribute('role', 'status');
    $('activeGoalRow').before(row);
  }
  const progress = runtime.progress?.selection === runtime.selectionGeneration ? runtime.progress : null;
  const entry = progress?.inputId ? runtime.pendingComposerInputs.find(item => item.id === progress.inputId) : undefined;
  const currentSelection = runtime.controlledSessionId === runtime.selectedId && runtime.controlledSelection === runtime.selectionGeneration;
  const finishDraft = currentSelection ? runtime.finishGoalDraftView : null;
  const draft = finishDraft ?? (currentSelection ? runtime.goalDraftView : null);
  const wait = currentSelection ? runtime.goalWaitView : null;
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  if (off && !finishDraft) {
    row.hidden = true;
    row.replaceChildren();
    row.setAttribute('aria-busy', 'false');
    return;
  }
  let phase = progress?.phase ?? '';
  let text = progress?.text ?? '';
  let error = progress?.error;
  if (entry) { phase = entry.state; error = entry.error ?? undefined; }
  if (draft && (!off || finishDraft) && (finishDraft || !['saving', 'failed'].includes(phase))) {
    phase = draft.stage;
    text = draft.text;
    error = draft.error ?? undefined;
  } else if (wait && !['saving', 'failed'].includes(phase)) {
    phase = 'settling';
    text = '';
    error = undefined;
  }
  const labels: Record<string, string> = {
    saving: t('Saving task…'),
    saved: t('Task saved · waiting for the next completed answer'),
    preparing: t('Preparing the opening message…'),
    generating: t('Generating the opening message…'),
    ready: t('Message ready · queued for delivery'),
    sending: t('Preparing a continuation…'),
    answering: t('Generating a continuation…'),
    queued: t('Opening message queued'),
    browser: t('Sending opening message to the provider…'),
    sent: t('Opening message sent'),
    tool: t('Opening message delivered to the active turn'),
    failed: t('Task could not continue'),
    cancelled: t('Opening message cancelled'),
    paused: t('Automation paused · task text preserved'),
    'no-reply': t('Goal reached')
  };
  if (phase === 'retrying') { text = ''; error = undefined; }
  labels.retrying = t('Provider busy · retry {0}{1}', [progress?.attempt ?? '', progress?.retryAt ? t(' at {0}', [new Date(progress.retryAt).toLocaleTimeString(currentLanguage())]) : '']);
  const mode = $<HTMLSelectElement>('chatAutomation').value === 'loop' ? t('Loop') : t('Goal');
  labels.settling = `${mode} · ${wait?.reason === 'native-busy' ? t('Provider resumed work · waiting before retry') : wait?.reason === 'silence' ? t('Waiting before recovery reload') : wait?.reason === 'quiet' ? t('Waiting for tool inactivity') :
    wait?.reason === 'workers' ? t('Waiting for this chat’s sub-agents') : wait?.reason === 'tools' ? t('Waiting for running tools') : wait?.reason === 'listening' ? t('Waiting for activity after recovery') : wait?.reason === 'closed' ? t('Paused until this chat is open in the browser') : t('Answer settling')}`;
  const sharedRecoveryWait = phase === 'settling' && wait?.until !== undefined &&
    ['silence', 'listening', 'native-busy', 'quiet'].includes(wait.reason) && runtime.controlledRecovery.some(countdown =>
      ['silence', 'post-reload', 'native-busy', 'thinking-failed'].includes(countdown.kind) &&
      countdown.deadline === wait.until && (countdown.visibleAt ?? 0) <= Date.now());
  row.hidden = !phase || sharedRecoveryWait || (phase === 'no-reply' && !error && runtime.goalReachedShown());
  if (row.hidden) {
    row.replaceChildren();
    row.setAttribute('aria-busy', 'false');
    return;
  }
  const busy = ['settling', 'saving', 'preparing', 'generating', 'retrying', 'sending', 'answering', 'browser', 'queued', 'ready'].includes(phase) && !error &&
    !(phase === 'settling' && wait?.reason === 'closed');
  row.setAttribute('aria-busy', String(busy));
  const marker = el('span', busy ? 'session-status is-working' : 'session-status');
  const body = el('div', 'queue-label');
  body.append(el('span', '', error ? `${labels.failed}: ${runtime.localizedGoalError(error)}` : labels[phase] ?? phase));
  if (text && ['generating', 'answering', 'preparing'].includes(phase)) body.append(el('pre', 'goal-live-preview', text.slice(-8000)));
  row.replaceChildren(marker, body);
  if (phase === 'settling' && wait?.reason === 'closed' && runtime.selectedId) {
    const id = runtime.selectedId;
    row.append(runtime.dockAction(() => t('Open this chat in your browser'), 'i-out', () => void runtime.openSessionChat(id)));
  }
  if (phase === 'settling' && wait?.until) {
    const seconds = Math.max(0, Math.ceil((wait.until - Date.now()) / 1000));
    const timer = el('span', 'recovery-countdown', seconds ? t('Check in {0}', [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`]) : t('Checking for activity…'));
    timer.setAttribute('role', 'timer');
    timer.setAttribute('aria-live', 'off');
    row.append(timer);
  }
}
