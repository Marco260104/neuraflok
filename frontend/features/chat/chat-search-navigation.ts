import type { SessionEvent } from '../../../contracts/session.js';
import { $, run } from '../../shared/dom.js';

export interface ChatSearchNavigationRuntime {
  api: Pick<typeof window.api, 'locateSearchMatch'>;
  readonly selectedId: string | null;
  readonly selectionGeneration: number;
  events: SessionEvent[];
  readonly historyLoading: boolean;
  readonly historyDemand: unknown | null;
  detailFor: string | null;
  historyBefore: number | null;
  historyStart: number | null;
  batchSize: number;
  itemKey(event: SessionEvent): string;
  loadDetail(navigate?: boolean, olderBefore?: number, newerFrom?: number): Promise<boolean>;
  readTimeline(): void;
}

export function createChatSearchNavigation(runtime: ChatSearchNavigationRuntime) {
  async function revealSearchMatch(id: string, query: string): Promise<void> {
    const selection = runtime.selectionGeneration;
    const current = (): boolean => selection === runtime.selectionGeneration && runtime.selectedId === id;
    const location = await run(runtime.api.locateSearchMatch(id, query));
    if (!location || !current()) return;
    const deadline = Date.now() + 5000;
    while (runtime.detailFor !== id || runtime.historyLoading || runtime.historyDemand !== null) {
      if (Date.now() > deadline || !current()) return;
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    }
    const rowFor = (): HTMLElement | null => {
      const event = runtime.events.find(candidate => candidate.seq === location.seq) ?? (location.messageId === null ? undefined
        : runtime.events.find(candidate => candidate.kind === location.kind && 'messageId' in candidate && candidate.messageId === location.messageId));
      if (!event) return null;
      const key = runtime.itemKey(event);
      return [...$('timeline').querySelectorAll<HTMLElement>('[data-timeline-key]')].find(row => row.dataset.timelineKey === key) ?? null;
    };
    let row = rowFor();
    if (!row) {
      const boundary = location.position + Math.ceil(runtime.batchSize / 2);
      runtime.events = [];
      runtime.historyStart = null;
      runtime.historyBefore = boundary;
      const loaded = await runtime.loadDetail(true, boundary);
      if (!current()) return;
      if (!loaded || !runtime.events.length) {
        runtime.historyBefore = null;
        runtime.detailFor = null;
        void runtime.loadDetail();
        return;
      }
      row = rowFor();
    }
    if (!row) return;
    runtime.readTimeline();
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('is-search-hit');
    void row.offsetWidth;
    row.classList.add('is-search-hit');
    window.setTimeout(() => row!.classList.remove('is-search-hit'), 2600);
  }

  return { revealSearchMatch };
}
