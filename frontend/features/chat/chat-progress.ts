import { createBackgroundProcessPanel } from './background-process-panel.js';
import { $ } from '../../shared/dom.js';
import { ui } from '../../shared/i18n.js';
import { createChatProgressStatus } from './chat-progress-status.js';
import { createChatTurnProgress } from './chat-turn-progress.js';
import type { ChatProgressRuntime } from './chat-progress-types.js';
export type { ChatProgressRuntime } from './chat-progress-types.js';

// Coordinates status polling, turn presentation, and background process updates.
export function createChatProgress(runtime: ChatProgressRuntime) {
  const status = createChatProgressStatus(runtime);
  const turn = createChatTurnProgress(runtime, status.stateLine);
  const backgroundProcessPanel = createBackgroundProcessPanel({
    api: runtime.api,
    selectedSession: () => runtime.selectedId,
    selectionGeneration: () => runtime.selectionGeneration,
    composerDockVisible: () => !$('composerDock').hidden,
  });

  function repaintBadges(): void {
    const key = status.badgeSignature();
    if (key === runtime.badgeKey) return;
    runtime.paintSessions();
  }

  // Updates the header, turn row, recovery timer, and session badges.
  function paintStateLine(): void {
    window.clearTimeout(runtime.durationTimer);
    runtime.durationTimer = undefined;
    const note = $('chatState');
    const visibleStateLine = () => turn.suppressWarmupWithoutPendingMessage()
      ? { text: '', tone: '' as const }
      : status.stateLine();
    const current = visibleStateLine();
    ui(note, 'textContent', () => visibleStateLine().text);
    note.className = `subhead-note${current.tone ? ` ${current.tone}` : ''}`;
    note.classList.toggle('is-working', current.working === true);
    const developer = runtime.state()?.config.ui.developerMode;
    if (!developer && !turn.hasStatusInTimeline())
      turn.parkTurnStatus(current.working === true);
    if (!developer && current.working === true)
      turn.paintTurnStatus(current);
    note.classList.toggle('is-mirrored', !developer);
    const recovering = runtime.paintRecoveryStatus();
    const goalWaiting =
      runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration &&
      !!runtime.goalWaitView;
    if (goalWaiting) runtime.paintGoalProgress();
    if (runtime.visible && (current.ticking || recovering || goalWaiting))
      runtime.durationTimer = window.setTimeout(paintStateLine, 1000);
    repaintBadges();
  }

  return {
    suppressWarmupWithoutPendingMessage: turn.suppressWarmupWithoutPendingMessage,
    get turnNow() {
      return turn.turnNow;
    },
    get turnWorking() {
      return turn.turnWorking;
    },
    parkTurnStatus: turn.parkTurnStatus,
    placeTurnLines: turn.placeTurnLines,
    exchangeDurations: turn.exchangeDurations,
    paintStateLine,
    badgeSignature: status.badgeSignature,
    paintBackgroundProcesses: () => backgroundProcessPanel.paint(),
    refreshBackgroundProcesses: () => backgroundProcessPanel.refresh(),
  };
}
