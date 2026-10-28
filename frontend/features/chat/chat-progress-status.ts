import type { AgentState } from '../../../contracts/session.js';
import { t } from '../../shared/i18n.js';
import type { ChatProgressRuntime } from './chat-progress-types.js';
import { transcriptOrSummaryShowsCompletedLatestTurn } from './chat-turn-state.js';

export interface ProgressStatus {
  text: string;
  tone: '' | 'is-live' | 'is-bad';
  working?: boolean;
  ticking?: boolean;
}

export function createChatProgressStatus(runtime: ChatProgressRuntime) {
  function badgeSignature(): string {
    return runtime.sessions
      .map((entry) =>
        runtime
          .sessionBadges(entry)
          .map((badge) => badge.text)
          .join(','),
      )
      .join('|');
  }
  // Recent tool activity can indicate work when a provider turn boundary is missing.
  const BLIND_CAPTION_MS = 90_000;
  // An open provider turn is not proof of progress. Stop displaying a growing
  // elapsed clock when the chat has produced no visible output or tool activity.
  const PROVIDER_SILENCE_MS = 90_000;

  function stateLine(): ProgressStatus {
    if (!runtime.state()?.config.ui.developerMode) {
      const summary = runtime.sessions.find(
        (entry) => entry.id === runtime.selectedId,
      );
      if (!summary || runtime.detailFor !== runtime.selectedId)
        return { text: '', tone: '' };
      const lastBoundary = [...runtime.events]
        .reverse()
        .find(
          (event) => event.kind === 'turn_start' || event.kind === 'turn_end',
        );
      const completedLatestTurn = transcriptOrSummaryShowsCompletedLatestTurn(runtime.events, summary);
      const controlledTurn =
        runtime.controlledSessionId === runtime.selectedId &&
        runtime.controlledSelection === runtime.selectionGeneration
          ? runtime.controlledTurnId
          : null;
      // A stale active-turn control must not keep the UI spinning after the
      // event stream has already closed that exact turn.
      const controlledTurnEnded = !!controlledTurn && runtime.events.some(
        (event) => (event.kind === 'turn_end' && event.turnId === controlledTurn && event.outcome !== 'unknown') ||
          (event.kind === 'assistant_message' && event.turnId === controlledTurn &&
            (event.final === true || event.state === 'final')),
      );
      const active = controlledTurnEnded || completedLatestTurn ? null : controlledTurn;
      if (!active && lastBoundary?.kind === 'turn_end' &&
          lastBoundary.outcome !== 'completed' && lastBoundary.outcome !== 'unknown') {
        return { text: '', tone: '' };
      }
      // Use recent attributed tool activity when the provider has not reported a turn boundary.
      const reportedEnd = Math.max(
        lastBoundary?.kind === 'turn_end' ? lastBoundary.time : 0,
        summary.lastTurnEndAt ?? 0,
        summary.lastAssistantFinalAt ?? 0,
      );
      const blind =
        !active &&
        !completedLatestTurn &&
        summary.lastToolCallAt !== null &&
        Date.now() - summary.lastToolCallAt < BLIND_CAPTION_MS &&
        summary.lastToolCallAt > reportedEnd
          ? { text: t('Working…'), tone: '' as const, working: true }
          : null;
      const turnId = active ?? lastBoundary?.turnId;
      if (!turnId) return blind ?? { text: '', tone: '' };
      const startedAt =
        summary.finishTurn?.turnId === turnId
          ? summary.finishTurn.startedAt
          : runtime.events.find(
              (event) => event.kind === 'turn_start' && event.turnId === turnId,
            )?.time;
      const endedAt = runtime.events.find(
        (event) => event.kind === 'turn_end' && event.turnId === turnId,
      )?.time;
      if (startedAt === undefined)
        return active
          ? { text: t('Working…'), tone: '', working: true }
          : (blind ?? { text: '', tone: '' });
      if (!active && endedAt === undefined)
        return blind ?? { text: '', tone: '' };
      if (blind) return blind;
      if (active) {
        let lastVisibleActivityAt = startedAt;
        for (const event of runtime.events) {
          if (event.time < startedAt || (event.turnId && event.turnId !== turnId)) continue;
          if (event.kind === 'tool_call' || event.kind === 'page_tool' ||
              event.kind === 'assistant_message' ||
              (event.kind === 'progress' && event.source === 'extension')) {
            lastVisibleActivityAt = Math.max(lastVisibleActivityAt, event.time);
          }
        }
        if (summary.lastToolCallAt !== null && summary.lastToolCallAt >= startedAt)
          lastVisibleActivityAt = Math.max(lastVisibleActivityAt, summary.lastToolCallAt);
        if (summary.lastAssistantFinalAt && summary.lastAssistantFinalAt >= startedAt)
          lastVisibleActivityAt = Math.max(lastVisibleActivityAt, summary.lastAssistantFinalAt);
        if (Date.now() - lastVisibleActivityAt >= PROVIDER_SILENCE_MS)
          return { text: t('Waiting for provider…'), tone: '', working: true };
      }
      const seconds = Math.max(
        0,
        Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000),
      );
      return {
        text: t('{0} for {1}{2}s', [
          active ? t('Working') : t('Worked'),
          seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : '',
          seconds % 60,
        ]),
        tone: '',
        working: !!active,
        ticking: !!active,
      };
    }
    // Report unattributed work without assigning it to an unverified conversation.
    const selected =
      runtime.sessions.find((entry) => entry.id === runtime.selectedId) ?? null;
    if (selected && selected.conversationId === null) {
      return {
        text: t(
          'Work this app could not place in a provider conversation — it may have come from another device or an unpaired browser',
        ),
        tone: '',
      };
    }

    const workers =
      runtime.swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
    if (workers.length === 0) return { text: '', tone: '' };
    const count = (state: AgentState): number =>
      workers.filter((agent) => agent.state === state).length;
    const parts: string[] = [];
    if (count('active') > 0) parts.push(t('{0} working', [count('active')]));
    // Invited workers have an assigned conversation but have not joined it yet.
    if (count('invited') > 0) parts.push(t('{0} opening', [count('invited')]));
    // Detached workers can continue reporting tools without an open browser tab.
    if (count('detached') > 0)
      parts.push(t('{0} working with no tab', [count('detached')]));
    if (count('waking') > 0) parts.push(t('{0} waking up', [count('waking')]));
    // Sleeping workers remain available for reuse by their run.
    if (count('sleeping') > 0)
      parts.push(t('{0} sleeping', [count('sleeping')]));
    if (count('finished') > 0)
      parts.push(t('{0} finished', [count('finished')]));
    if (count('failed') > 0) parts.push(t('{0} failed', [count('failed')]));
    const live =
      count('invited') + count('active') + count('detached') + count('waking');
    return {
      text: `${workers.length === 1 ? t('1 worker') : t('{0} workers', [workers.length])} · ${parts.join(' · ')}`,
      tone: count('failed') > 0 ? 'is-bad' : live > 0 ? 'is-live' : '',
    };
  }
  return { badgeSignature, stateLine };
}
