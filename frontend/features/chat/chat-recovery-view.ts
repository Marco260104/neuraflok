import type { Handoff, SessionEvent, SessionSummary } from '../../../contracts/session.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import { positionOf } from '../../../contracts/chronology.js';
import { $, ago, compactNumber, el, icon, run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { renderRecoveryCountdowns } from './recovery.js';

type Runtime = {
  api: Pick<typeof window.api, 'cancelRecovery' | 'getHandoff'>;
  run: typeof run;
  sessions: SessionSummary[];
  selectedId: string | null;
  controlledSessionId: string | null;
  controlledSelection: number;
  selectionGeneration: number;
  controlledRecovery: RecoveryCountdown[];
  detailFor: string | null;
  events: readonly SessionEvent[];
  handoff: Handoff | null;
  handoffFor: string | null;
  handoffLoadGeneration: number;
  dismissedRecoveryNotices: Map<string, string>;
  refreshSessionControls(): Promise<void>;
  paintStateLine(): void;
  dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement;
};

export function createChatRecoveryView(runtime: Runtime) {
  async function loadHandoff(): Promise<void> {
    const sessionId = runtime.selectedId;
    const generation = ++runtime.handoffLoadGeneration;
    const summary = runtime.sessions.find(session => session.id === sessionId) ?? null;
    const wanted = summary?.lastHandoffId ?? null;
    if (wanted === null) {
      if (generation !== runtime.handoffLoadGeneration || runtime.selectedId !== sessionId) return;
      runtime.handoff = null;
      runtime.handoffFor = null;
      paintHandoff();
      return;
    }
    if (runtime.handoffFor === wanted) return;
    const loaded = await runtime.run(runtime.api.getHandoff(summary!.id, wanted));
    if (generation !== runtime.handoffLoadGeneration || runtime.selectedId !== sessionId) return;
    runtime.handoff = loaded ?? null;
    runtime.handoffFor = wanted;
    paintHandoff();
  }

  function paintHandoff(): void {
    const hand = $('handoffBox');
    if (runtime.handoff) {
      const saved = runtime.handoff;
      const parts: HTMLElement[] = [];
      const head = el('p', 'hint');
      ui(head, 'textContent', () => t('{0} characters · from {1} events (~{2} tokens) · {3}', [
        compactNumber(saved.text.length),
        saved.sourceEvents,
        compactNumber(saved.sourceTokens),
        ago(saved.createdAt)
      ]));
      parts.push(head);
      for (const note of saved.notes) parts.push(el('p', 'hint is-warn', note));
      parts.push(el('pre', 'pre', saved.text));
      hand.replaceChildren(...parts);
      $('handoffHead').hidden = false;
      $('copyHandoff').hidden = false;
    } else {
      hand.replaceChildren();
      $('handoffHead').hidden = true;
      $('copyHandoff').hidden = true;
    }
    runtime.paintStateLine();
  }

  function paintRecoveryStatus(): boolean {
    const host = $('recoveryStatus');
    const countdowns = runtime.selectedId && runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration ? runtime.controlledRecovery : [];
    const sessionForCountdown = runtime.controlledSessionId;
    const cancelReload = (countdown: RecoveryCountdown) => countdown.kind === 'assistant-error' && sessionForCountdown
      ? runtime.dockAction(() => t("Don't reload this answer"), 'i-x', async () => {
        const cancelled = await run(runtime.api.cancelRecovery(sessionForCountdown));
        if (cancelled === false) toast(t('The reload has already started.'));
        await runtime.refreshSessionControls();
      })
      : null;
    if (renderRecoveryCountdowns(host, countdowns, Date.now(), cancelReload)) return true;
    const recovery = runtime.detailFor === runtime.selectedId
      ? [...runtime.events].reverse().find(event => event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:'))
      : undefined;
    const sessionId = runtime.selectedId;
    const revision = recovery?.kind === 'progress'
      ? JSON.stringify([recovery.progressId, recovery.time, recovery.message.text])
      : '';
    const advanced = recovery && runtime.events.some(event => positionOf(event) > positionOf(recovery) &&
      ((event.kind === 'turn_start' && event.turnId !== recovery.turnId) ||
        (event.kind === 'user_message' && event.source === 'extension')));
    host.hidden = !recovery || !!advanced || Date.now() - recovery.time > 120000 ||
      (!!sessionId && runtime.dismissedRecoveryNotices.get(sessionId) === revision);
    host.replaceChildren();
    if (host.hidden) return paintRecoveryVerdict(host, sessionId);
    if (recovery?.kind === 'progress') {
      const row = el('div', 'recovery-notice');
      row.append(icon('i-pulse'), el('span', 'queue-label', recovery.message.text),
        runtime.dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
          if (sessionId) runtime.dismissedRecoveryNotices.set(sessionId, revision);
          host.hidden = true;
          host.replaceChildren();
        }));
      host.append(row);
    }
    return false;
  }

  function paintRecoveryVerdict(host: HTMLElement, sessionId: string | null): boolean {
    // Keep the latest app verdict visible until new user work supersedes it or the user dismisses it.
    const verdict = runtime.detailFor === runtime.selectedId
      ? [...runtime.events].reverse().find(event => event.source === 'app' && event.kind === 'note' && !event.continuation)
      : undefined;
    if (verdict?.kind !== 'note') return false;
    const revision = JSON.stringify(['note', verdict.time, verdict.message.text]);
    const superseded = runtime.events.some(event => positionOf(event) > positionOf(verdict) &&
      (event.kind === 'turn_start' || (event.kind === 'user_message' && event.source === 'extension')));
    if (superseded || (!!sessionId && runtime.dismissedRecoveryNotices.get(sessionId) === revision)) return false;
    const row = el('div', 'recovery-notice');
    row.append(icon('i-pulse'), el('span', 'queue-label', verdict.message.text),
      runtime.dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
        if (sessionId) runtime.dismissedRecoveryNotices.set(sessionId, revision);
        host.hidden = true;
        host.replaceChildren();
      }));
    host.append(row);
    host.hidden = false;
    return false;
  }

  return { loadHandoff, paintHandoff, paintRecoveryStatus };
}
