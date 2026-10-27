import { chronological, positionOf } from '../../../contracts/chronology.js';
import { foldProgress, type SessionEvent, type SessionSummary } from '../../../contracts/session.js';
import type { AppState } from '../../../contracts/types.js';
import { $, run } from '../../shared/dom.js';
import type { TimelineItem } from './timeline-presentation.js';
import { createChatTimelineAgentFilter } from './chat-timeline-agent-filter.js';

export interface ChatTimelineHistoryRuntime {
  api: Pick<typeof window.api, 'getSession'>;
  run: typeof run;
  sessions: SessionSummary[];
  visible: boolean;
  selectedId: string | null;
  selectionGeneration: number;
  detailFor: string | null;
  events: SessionEvent[];
  detailCursor: number | null;
  detailLoadGeneration: number;
  handoffLoadGeneration: number;
  totalEvents: number;
  detailStamp: { updatedAt: number; events: number } | null;
  roundsEnter: boolean;
  sidebarCompletion: { markSeen: (summary: SessionSummary | undefined) => void } | undefined;
  historyBefore: number | null;
  historyStart: number | null;
  historyDemand: { sessionId: string; selection: number; direction: number; opening: boolean } | null;
  historyLoading: boolean;
  historyRefreshPending: boolean;
  agentFilter: string | null;
  filterFor: string | null;
  UNATTRIBUTED: string;
  MAX_TIMELINE_ROWS: number;
  TIMELINE_BATCH_SIZE: number;
  timelineShown: () => boolean;
  timelineItems: (source: SessionEvent[]) => TimelineItem[];
  itemKey: (item: TimelineItem) => string;
  refreshSessionControls: () => Promise<void>;
  paintDetail: (followBottom?: boolean) => void;
  adoptPlanFromEvents?: (events: SessionEvent[]) => void;
  paintSessions: () => void;
  loadHandoff: () => Promise<void>;
  state: () => AppState | null;
}

type Runtime = ChatTimelineHistoryRuntime;

export function canonicalMessageKey(event: SessionEvent): string | null {
  if (event.kind === 'tool_call') return `tool_call\u0000${event.call.callId}`;
  if (event.kind === 'native_image') return `native_image\u0000${event.messageId}\u0000${event.providerAssetId}`;
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

// Owns timeline history paging, filters, and bounded page retention.
export function createChatTimelineHistory(runtime: Runtime) {
  function mergeDetailDelta(delta: SessionEvent[]): void {
    if (delta.length === 0) return;
    const merged = [...runtime.events];
    const floor = runtime.events.length ? Math.min(...runtime.events.map(positionOf)) : 0;
    const messageRows = new Map<string, number>();
    for (let index = 0; index < merged.length; index++) {
      const key = canonicalMessageKey(merged[index]!);
      if (key) messageRows.set(key, index);
    }
    for (const event of delta) {
      const key = canonicalMessageKey(event);
      const index = key ? messageRows.get(key) : undefined;
      if (index !== undefined) merged[index] = event;
      else {
        if (positionOf(event) < floor) continue;
        if (key) messageRows.set(key, merged.length);
        merged.push(event);
      }
    }
    runtime.events = retainTimelinePage(chronological(foldProgress(merged)), 'newer');
  }

  async function adoptUnboundPlan(selection: number, generation: number): Promise<void> {
    if (!runtime.adoptPlanFromEvents) return;
    const id = runtime.sessions[0]?.id;
    if (!id) return;
    const detail = await runtime.run(runtime.api.getSession(id, { limit: runtime.TIMELINE_BATCH_SIZE }));
    if (
      generation !== runtime.detailLoadGeneration ||
      selection !== runtime.selectionGeneration ||
      runtime.selectedId !== null
    ) return;
    runtime.adoptPlanFromEvents(detail?.events ?? []);
  }

  async function loadDetail(navigate = false, olderBefore?: number, newerFrom?: number): Promise<boolean> {
    const prepend = olderBefore !== undefined;
    const wanted = runtime.selectedId;
    const selection = runtime.selectionGeneration;
    const observed = wanted === null ? undefined : runtime.sessions.find(row => row.id === wanted);
    const observedCompletion = observed ? { ...observed } : undefined;
    if (wanted !== null && (runtime.historyBefore !== null || runtime.historyLoading) && runtime.detailFor === wanted && !navigate) {
      if (runtime.historyLoading) runtime.historyRefreshPending = true;
      void runtime.refreshSessionControls();
      runtime.paintDetail();
      return false;
    }
    const generation = ++runtime.detailLoadGeneration;
    void runtime.refreshSessionControls();
    if (wanted === null) {
      runtime.handoffLoadGeneration++;
      runtime.historyBefore = null;
      runtime.events = [];
      runtime.totalEvents = 0;
      runtime.detailFor = null;
      runtime.detailCursor = null;
      $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
      runtime.paintDetail();
      void adoptUnboundPlan(selection, generation);
      return false;
    }
    const opening = runtime.detailFor !== wanted;
    if (opening) {
      runtime.historyBefore = null;
      runtime.historyStart = null;
      runtime.roundsEnter = false;
    }
    const incremental = !prepend && newerFrom === undefined && runtime.historyBefore === null && runtime.detailFor === wanted && runtime.detailCursor !== null;
    const detail = await runtime.run(
      runtime.api.getSession(wanted, newerFrom !== undefined
        ? { after: newerFrom, limit: runtime.TIMELINE_BATCH_SIZE }
        : incremental
          ? { from: runtime.detailCursor!, limit: runtime.TIMELINE_BATCH_SIZE }
          : { ...(olderBefore !== undefined ? { before: olderBefore } : runtime.historyBefore !== null ? { before: runtime.historyBefore } : {}), limit: runtime.TIMELINE_BATCH_SIZE })
    );
    if (generation !== runtime.detailLoadGeneration || selection !== runtime.selectionGeneration || runtime.selectedId !== wanted) return false;
    if (!detail) {
      if (opening) {
        $('timeline').replaceChildren();
        $('timeline').removeAttribute('inert');
        $('timeline').removeAttribute('aria-busy');
      }
      return false;
    }
    if (prepend && !detail.events.length) return true;
    if (incremental) mergeDetailDelta(detail.events);
    else {
      const folded = chronological(foldProgress(detail.events));
      if (newerFrom !== undefined) {
        runtime.events = retainTimelinePage(chronological(foldProgress([...runtime.events, ...folded])), 'newer');
        if (detail.events.length < runtime.TIMELINE_BATCH_SIZE) runtime.historyBefore = null;
      } else if (prepend) {
        const boundary = olderBefore!;
        runtime.historyBefore = boundary;
        const retained = runtime.events.filter(event => positionOf(event) >= boundary);
        runtime.events = retainTimelinePage(chronological(foldProgress([...folded, ...retained])), 'older');
      } else runtime.events = chronological([...folded].sort((a, b) => positionOf(a) - positionOf(b)).slice(-runtime.MAX_TIMELINE_ROWS));
      runtime.detailFor = wanted;
    }
    runtime.detailCursor = Math.max(opening ? 0 : runtime.detailCursor ?? 0,
      typeof detail.nextFrom === 'number'
        ? detail.nextFrom
        : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? runtime.detailCursor! : 0));
    runtime.totalEvents = detail.total;
    if (!prepend && newerFrom === undefined)
      runtime.detailStamp = observedCompletion ? { updatedAt: observedCompletion.updatedAt, events: observedCompletion.events } : null;
    if (generation !== runtime.detailLoadGeneration || selection !== runtime.selectionGeneration || runtime.selectedId !== wanted) return false;
    if (opening) $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
    if (prepend || newerFrom !== undefined) runtime.roundsEnter = false;
    runtime.adoptPlanFromEvents?.(runtime.events);
    runtime.paintDetail(!prepend && newerFrom === undefined);
    if (runtime.visible && runtime.historyBefore === null && generation === runtime.detailLoadGeneration && selection === runtime.selectionGeneration && runtime.selectedId === wanted) {
      runtime.sidebarCompletion?.markSeen(observedCompletion);
      runtime.paintSessions();
    }
    if (opening) $('chatBody').scrollTop = $('chatBody').scrollHeight;
    if (opening) requestHistory(-1, true);
    void runtime.loadHandoff();
    if (incremental && detail.events.length === runtime.TIMELINE_BATCH_SIZE && runtime.selectedId === wanted) {
      window.setTimeout(() => void loadDetail(), 0);
    }
    return true;
  }

  // Fills the requested visible history edge through bounded storage reads.
  function requestHistory(direction: number, opening = false): void {
    if (
      !runtime.selectedId ||
      runtime.detailFor !== runtime.selectedId ||
      !direction ||
      !runtime.timelineShown()
    )
      return;
    runtime.historyDemand = {
      sessionId: runtime.selectedId,
      selection: runtime.selectionGeneration,
      direction,
      opening,
    };
    void fillTimelineHistory();
  }

  async function fillTimelineHistory(): Promise<void> {
    if (runtime.historyLoading) return;
    runtime.historyLoading = true;
    let filledOpening = false;
    try {
      while (runtime.historyDemand) {
        const demand = runtime.historyDemand;
        if (
          demand.sessionId !== runtime.selectedId ||
          demand.selection !== runtime.selectionGeneration ||
          runtime.detailFor !== runtime.selectedId
        ) {
          runtime.historyDemand = null;
          break;
        }
        const pane = $('chatBody'),
          timeline = $('timelineContent');
        const buffer = Math.min(480, Math.max(160, pane.clientHeight / 2));
        const reserve =
          Number.parseFloat(
            timeline.style.getPropertyValue('--timeline-scroll-reserve'),
          ) || 0;
        const nearEdge = demand.opening
          ? timeline.getBoundingClientRect().height - reserve <
            pane.clientHeight + buffer
          : demand.direction < 0
            ? pane.scrollTop <= buffer
            : pane.scrollHeight -
                reserve -
                pane.clientHeight -
                pane.scrollTop <=
              buffer;
        if (
          pane.clientHeight <= 0 ||
          !nearEdge ||
          (demand.direction > 0 && runtime.historyBefore === null)
        ) {
          runtime.historyDemand = null;
          break;
        }
        const cursor =
          demand.direction < 0
            ? runtime.events.reduce(
                (oldest, event) => Math.min(oldest, positionOf(event)),
                Infinity,
              )
            : runtime.events.reduce(
                (newest, event) => Math.max(newest, positionOf(event)),
                0,
              );
        if (
          !Number.isFinite(cursor) ||
          (demand.direction < 0 &&
            (cursor <= 1 || cursor === runtime.historyStart))
        ) {
          runtime.historyDemand = null;
          break;
        }
        const loaded = await loadDetail(
          true,
          demand.direction < 0 ? cursor : undefined,
          demand.direction > 0 ? cursor : undefined,
        );
        if (
          demand.sessionId !== runtime.selectedId ||
          demand.selection !== runtime.selectionGeneration ||
          runtime.detailFor !== runtime.selectedId
        )
          continue;
        if (!loaded) {
          if (demand === runtime.historyDemand) runtime.historyDemand = null;
          continue;
        }
        const next =
          demand.direction < 0
            ? runtime.events.reduce(
                (oldest, event) => Math.min(oldest, positionOf(event)),
                Infinity,
              )
            : runtime.events.reduce(
                (newest, event) => Math.max(newest, positionOf(event)),
                0,
              );
        if (demand === runtime.historyDemand && demand.opening) {
          // Keep a newly selected chat at its live tail until the reader moves.
          runtime.historyBefore = null;
          timeline.style.removeProperty('--timeline-scroll-reserve');
          pane.scrollTop = pane.scrollHeight;
          filledOpening = true;
        }
        if (next === cursor) {
          if (demand.direction < 0) runtime.historyStart = cursor;
          if (demand === runtime.historyDemand) runtime.historyDemand = null;
        }
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        );
      }
    } finally {
      runtime.historyLoading = false;
      const refresh = filledOpening || runtime.historyRefreshPending;
      runtime.historyRefreshPending = false;
      if (runtime.historyDemand) void fillTimelineHistory();
      else if (refresh && runtime.historyBefore === null)
        void loadDetail();
    }
  }

  const agentFilter = createChatTimelineAgentFilter(runtime);

  // Retains the visible history window and protects rows the reader is inspecting.
  function retainTimelinePage(
    source: SessionEvent[],
    direction: 'older' | 'newer',
  ): SessionEvent[] {
    // Sort by immutable history positions before trimming a page.
    source = [...source].sort((a, b) => positionOf(a) - positionOf(b));
    const pane = $('chatBody');
    const edge = pane.getBoundingClientRect().top;
    const protectedKeys = new Set<string>();
    for (const row of $('timeline').querySelectorAll<HTMLElement>(
      '[data-timeline-key]',
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= edge - pane.clientHeight) continue;
      if (rect.top >= edge + 2 * pane.clientHeight) break;
      protectedKeys.add(row.dataset.timelineKey!);
      if (row.matches('.tool-group:not([open])')) {
        for (const child of row.querySelectorAll<HTMLElement>(
          '[data-timeline-key]',
        ))
          protectedKeys.add(child.dataset.timelineKey!);
      }
    }
    const protectedSeqs = new Set<number>();
    for (const item of runtime.timelineItems(source)) {
      if (
        item.kind !== 'compaction' ||
        !protectedKeys.has(runtime.itemKey(item))
      )
        continue;
      const block = item.block;
      protectedSeqs.add(block.seq);
      for (const event of [
        block.prompt,
        block.brief,
        block.end,
        block.handoff,
        block.resume,
        ...block.notes,
      ]) {
        if (event) protectedSeqs.add(event.seq);
      }
    }
    const protectedIndexes = source.flatMap((event, index) =>
      protectedSeqs.has(event.seq) ||
      protectedKeys.has(runtime.itemKey({ kind: 'event', event }))
        ? [index]
        : [],
    );
    const first = protectedIndexes[0] ?? source.length;
    const last = protectedIndexes.at(-1) ?? -1;
    if (direction === 'older') {
      const end = Math.min(
        source.length,
        Math.max(runtime.MAX_TIMELINE_ROWS, last + 1),
      );
      return chronological(source.slice(0, end));
    }
    const start = Math.max(
      0,
      Math.min(source.length - runtime.MAX_TIMELINE_ROWS, first),
    );
    return chronological(source.slice(start));
  }

  return {
    loadDetail,
    requestHistory,
    fillTimelineHistory,
    ...agentFilter,
    retainTimelinePage,
  };
}
