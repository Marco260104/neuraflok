/** Coordinates chat search requests, keyboard controls, and dialog lifecycle. */
import type { SessionSearchReply } from '../../../contracts/session.js';
import { $, icon, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { closeRowMenu } from './row-menu.js';
import { isMac, primaryShortcut } from '../settings/shortcuts.js';
import { renderChatSearchResults } from './chat-search-view.js';

const api = window.api;
const TYPING_PAUSE_MS = 150;
const INDEXING_RECHECK_MS = 700;
const REFRESH_MS = 3000;
export interface ChatSearch {
  /** Opens the search dialog (its button, ⌘K / Ctrl+K and the View menu). */
  open(): void;
  /** Chats changed: an open search runs again, so new words and titles are found. */
  refresh(): void;
  /** The search dialog is open with a query and its results are shown. */
  readonly active: boolean;
}

export interface ChatSearchOptions {
  /** Opens a chat; `match` is the query when the result matched by what was said, to open at that message. */
  select(id: string, match?: string): void;
  selectedId(): string | null;
  /** The newest chats, newest first, offered before anything is typed. */
  recent(): Array<{ id: string; title: string }>;
}

export function initChatSearch(options: ChatSearchOptions): ChatSearch {
  const dialog = $<HTMLDialogElement>('searchDialog');
  const field = $<HTMLInputElement>('chatSearch');
  const clear = $<HTMLButtonElement>('chatSearchClear');
  const results = $('searchResults');
  const opener = $<HTMLButtonElement>('searchChatsButton');
  let generation = 0;
  let typingTimer = 0;
  let recheckTimer = 0;
  let last: SessionSearchReply | null = null;
  let searchedAt = 0;

  const query = (): string => field.value.trim();

  /** Closes after the exit animation, so the box fades out instead of vanishing. With no animation (reduced motion, or no stylesheet) it closes at once. */
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const finish = (): void => {
      if (!dialog.classList.contains('is-closing')) return;
      dialog.classList.remove('is-closing');
      dialog.close();
    };
    const animation = window.getComputedStyle(dialog).animationName;
    if (!animation || animation === 'none') { finish(); return; }
    dialog.addEventListener('animationend', function ended(event) {
      if (event.target !== dialog) return;
      dialog.removeEventListener('animationend', ended);
      finish();
    });
    // Never left half closed if the animation is skipped (a hidden window does not run it).
    window.setTimeout(finish, 300);
  };

  const paint = (): void => renderChatSearchResults({
    container: results,
    query: query(),
    reply: last,
    recent: () => options.recent(),
    selectedId: () => options.selectedId(),
    close,
    select: (id, match) => options.select(id, match)
  });

  const search = async (): Promise<void> => {
    window.clearTimeout(recheckTimer);
    const text = query();
    const mine = ++generation;
    clear.hidden = !field.value;
    if (!text) { last = null; paint(); return; }
    searchedAt = Date.now();
    const reply = await run(api.searchSessions(text));
    if (mine !== generation || !reply || !dialog.open) return;
    last = reply;
    paint();
    // Words of chats not indexed yet can still match: ask again until indexing is done.
    if (reply.indexed < reply.total) recheckTimer = window.setTimeout(() => { if (mine === generation) void search(); }, INDEXING_RECHECK_MS);
  };

  const later = (): void => {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void search(), TYPING_PAUSE_MS);
  };

  const open = (): void => {
    dialog.classList.remove('is-closing');
    // A chat's row menu is not part of the dialog: left open, it stayed over the dialog and after it.
    closeRowMenu();
    if (!dialog.open) dialog.showModal();
    field.focus();
    field.select();
    void search();
  };

  ui(field, 'placeholder', () => t("Search chats"));
  ui(field, 'aria-label', () => t("Search chats"));
  ui(dialog, 'aria-label', () => t("Search chats"));
  ui(clear, 'title', () => t("Clear search"));
  ui(clear, 'aria-label', () => t("Clear search"));
  ui(opener, 'title', () => `${t("Search chats")} (${primaryShortcut('K')})`);
  ui(opener, 'aria-label', () => t("Search chats"));
  if (!clear.firstChild) clear.append(icon('i-x'));
  field.addEventListener('input', () => { clear.hidden = !field.value; later(); });
  field.addEventListener('keydown', (event) => {
    // Escape closes the dialog after clearing the search field, as in common chat interfaces.
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
  clear.addEventListener('click', () => { field.value = ''; field.focus(); void search(); });
  // ⌘K on macOS and Ctrl+K elsewhere open chat search, except in the terminal where Ctrl+K deletes to the end of the line.
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'k' || event.shiftKey || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    event.preventDefault();
    open();
  });
  opener.addEventListener('click', open);
  // A click on the backdrop lands on the dialog itself, never on its contents.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  // Escape anywhere in the dialog: the same animated close instead of the instant native one.
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    // The close event arrives after the fact: when the dialog was opened again meanwhile, the search typed into it is current and must not be cancelled.
    if (dialog.open) return;
    window.clearTimeout(typingTimer);
    window.clearTimeout(recheckTimer);
    generation++;
  });
  results.addEventListener('keydown', (event) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown' && at < rows.length - 1) { event.preventDefault(); rows[at + 1]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); (at > 0 ? rows[at - 1]! : field).focus(); }
  });

  return {
    open,
    // Chats change many times a second while they run; a running search catches up at most every few seconds instead of re-reading the busy chat on every change.
    refresh: () => { if (dialog.open && query() && Date.now() - searchedAt > REFRESH_MS) later(); },
    get active() { return dialog.open && Boolean(query()); }
  };
}
