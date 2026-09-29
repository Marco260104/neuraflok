import type { SessionSearchReply } from '../../../contracts/session.js';
import { el } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

const RECENT_CHAT_LIMIT = 30;

interface ChatSearchViewOptions {
  container: HTMLElement;
  query: string;
  reply: SessionSearchReply | null;
  recent(): Array<{ id: string; title: string }>;
  selectedId(): string | null;
  close(): void;
  select(id: string, match?: string): void;
}

function markedText(tag: 'b' | 'span', className: string, text: string, ranges: Array<[number, number]> = []): HTMLElement {
  const node = el(tag, className);
  node.dir = 'auto';
  let offset = 0;
  for (const [start, end] of ranges) {
    if (start < offset) continue;
    if (start > offset) node.append(text.slice(offset, start));
    node.append(el('mark', '', text.slice(start, end)));
    offset = end;
  }
  if (offset < text.length) node.append(text.slice(offset));
  return node;
}

function resultButton(
  options: ChatSearchViewOptions,
  id: string,
  title: HTMLElement,
  snippet?: HTMLElement,
  matchedText?: string
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `search-result${id === options.selectedId() ? ' is-sel' : ''}`;
  button.dataset.searchId = id;
  button.setAttribute('role', 'listitem');
  button.append(title);
  if (snippet) button.append(snippet);
  button.addEventListener('click', () => {
    options.close();
    options.select(id, matchedText);
  });
  return button;
}

function resultList(rows: HTMLElement[]): HTMLElement {
  const list = el('div', 'search-list');
  list.setAttribute('role', 'list');
  list.append(...rows);
  return list;
}

export function renderChatSearchResults(options: ChatSearchViewOptions): void {
  const { container, query, reply } = options;
  container.replaceChildren();
  if (!query) {
    const recent = options.recent().slice(0, RECENT_CHAT_LIMIT);
    if (!recent.length) return;
    container.append(
      el('p', 'search-heading', () => t('Recent')),
      resultList(recent.map(chat => resultButton(options, chat.id,
        markedText('b', '', chat.title || t('Untitled session')))))
    );
    return;
  }
  if (!reply) return;
  container.append(resultList(reply.results.map(result => resultButton(
    options,
    result.id,
    result.title
      ? markedText('b', '', result.title, result.titleMatches)
      : markedText('b', '', t('Untitled session')),
    result.snippet ? markedText('span', 'search-snippet', result.snippet.text, result.snippet.matches) : undefined,
    result.snippet ? query : undefined
  ))));
  if (reply.indexed < reply.total) {
    container.append(el('p', 'search-status', () => t('Searching message text… {0} of {1} chats', [reply.indexed, reply.total])));
  } else if (!reply.results.length) {
    container.append(el('p', 'empty search-status', () => t('No chats match')));
  } else if (reply.limited) {
    container.append(el('p', 'search-status', () => t('Showing the first {0} matches. Add a word to narrow them down.', [reply.results.length])));
  }
}
