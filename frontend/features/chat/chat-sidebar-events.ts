import type { SessionSummary } from '../../../contracts/session.js';
import { $ } from '../../shared/dom.js';
import { initChatSearch, type ChatSearch } from './chat-search.js';

interface ChatSidebarEventsRuntime {
  selectedId(): string | null;
  sessions(): SessionSummary[];
  clearPendingNewInput(): void;
  selectSession(id: string): void;
  revealSearchMatch(id: string, query: string): void;
  maybePageSessions(): void;
  showView(name: string): void;
  setAgentFilter(value: string | null): void;
  paintDetail(): void;
}

export function bindChatSidebarEvents(runtime: ChatSidebarEventsRuntime): ChatSearch {
  const search = initChatSearch({
    select: (id, match) => {
      if (id !== runtime.selectedId()) {
        runtime.clearPendingNewInput();
        runtime.selectSession(id);
      }
      if (match) runtime.revealSearchMatch(id, match);
    },
    selectedId: runtime.selectedId,
    recent: () => runtime.sessions()
      .filter(entry => entry.origin?.kind !== 'worker' && entry.origin?.kind !== 'helper' && (!!entry.conversationId || entry.origin?.kind === 'desktop'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(entry => ({ id: entry.id, title: entry.title }))
  });

  $('sessionList').addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === runtime.selectedId()) return;
    runtime.clearPendingNewInput();
    runtime.selectSession(row.dataset.id);
  });
  $('sessionList').addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' '].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const control = target.closest<HTMLElement>('[data-session-select]');
    const row = control?.closest<HTMLElement>('[data-id]');
    if (!control || target !== control || !row?.dataset.id) return;
    event.preventDefault();
    if (row.dataset.id === runtime.selectedId()) return;
    runtime.clearPendingNewInput();
    runtime.selectSession(row.dataset.id);
  });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', runtime.maybePageSessions);
  $('chatView').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (button?.dataset.view) runtime.showView(button.dataset.view);
  });
  $('chatAgentFilter').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    runtime.setAgentFilter(button.dataset.agent === '' ? null : button.dataset.agent ?? null);
    runtime.paintDetail();
  });

  return search;
}
