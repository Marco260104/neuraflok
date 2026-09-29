import type { SessionEvent } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { $ } from '../../shared/dom.js';

export interface ChatSendAnchor {
  key: string;
  inputId: string;
  messageId?: string;
  before: Set<string>;
  session: string | null;
  seen: boolean;
  smoothUntil: number;
}

interface Runtime {
  selectedId(): string | null;
  pendingComposerInputs(): readonly InputEntry[];
  events(): readonly SessionEvent[];
  historyBefore(): number | null;
  detailCursor(): number | null;
  setHistoryBefore(value: number | null): void;
  setDetailFor(value: string | null): void;
  loadDetail(): void;
}

export interface ChatReaderState {
  sendAnchor: ChatSendAnchor | null;
  readingAfterSend: boolean;
  readerAtEnd: boolean;
  userMessageKeys(): Set<string>;
  holdSentMessage(): boolean;
  distanceFromTail(): number;
  timelineShown(): boolean;
  paintJumpLatest(): void;
  jumpToLatest(): void;
  readTimeline(): void;
  releaseSendHold(): void;
}

const USER_MESSAGE_KEY = 'message:user_message\u0000';
const SEND_TOP_GAP = 16;
const JUMP_DISTANCE = 150;
const SEND_GLIDE_MS = 700;

export function createChatReaderState(runtime: Runtime): ChatReaderState {
  let sendAnchor: ChatSendAnchor | null = null;
  let readingAfterSend = false;
  let readerAtEnd = true;

  function userMessageKeys(): Set<string> {
    const keys = new Set<string>();
    for (const row of $('timelineContent').querySelectorAll<HTMLElement>('[data-timeline-key]')) {
      if (row.dataset.timelineKey!.startsWith(USER_MESSAGE_KEY)) keys.add(row.dataset.timelineKey!);
    }
    return keys;
  }

  function scrollPane(pane: HTMLElement, top: number, smooth: boolean): void {
    if (typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    else pane.scrollTop = top;
  }

  function holdSentMessage(): boolean {
    const anchor = sendAnchor;
    if (!anchor) return false;
    if (anchor.session !== runtime.selectedId()) { sendAnchor = null; return false; }
    const pane = $('chatBody');
    const content = $('timelineContent');
    const rows = [...content.querySelectorAll<HTMLElement>('[data-timeline-key]')];
    let row = rows.find(node => node.dataset.timelineKey === anchor.key);
    anchor.messageId ??= runtime.pendingComposerInputs().find(entry => entry.id === anchor.inputId)?.messageId;
    if (!row) {
      const key = anchor.messageId && `${USER_MESSAGE_KEY}${anchor.messageId}`;
      row = (key && rows.find(node => node.dataset.timelineKey === key)) ||
        rows.findLast(node => node.dataset.timelineKey!.startsWith(USER_MESSAGE_KEY) && !anchor.before.has(node.dataset.timelineKey!));
      if (row) anchor.key = row.dataset.timelineKey!;
    }
    if (!row || !row.getClientRects().length) return false;
    if (!anchor.seen) { anchor.seen = true; anchor.smoothUntil = Date.now() + SEND_GLIDE_MS; }
    const transform = getComputedStyle(row).transform;
    const shift = transform && transform !== 'none' && typeof DOMMatrixReadOnly === 'function' ? new DOMMatrixReadOnly(transform).m42 : 0;
    const top = Math.max(0, pane.scrollTop + row.getBoundingClientRect().top - shift - pane.getBoundingClientRect().top - SEND_TOP_GAP);
    const current = Number.parseFloat(content.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
    const reserve = Math.max(0, Math.ceil(top + pane.clientHeight - (pane.scrollHeight - current)));
    if (reserve !== current) {
      if (reserve > 0) content.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      else content.style.removeProperty('--timeline-scroll-reserve');
    }
    if (Math.abs(pane.scrollTop - top) > 0.5) scrollPane(pane, top, Date.now() < anchor.smoothUntil);
    paintJumpLatest();
    return true;
  }

  function distanceFromTail(): number {
    const pane = $('chatBody');
    const reserve = Number.parseFloat($('timelineContent').style.getPropertyValue('--timeline-scroll-reserve')) || 0;
    return pane.scrollHeight - reserve - pane.clientHeight - pane.scrollTop;
  }

  function timelineShown(): boolean {
    return !$('timelineContent').hidden;
  }

  function paintJumpLatest(): void {
    const jump = document.getElementById('jumpLatest');
    if (jump) jump.classList.toggle('is-shown', !!runtime.selectedId() && timelineShown() && distanceFromTail() > JUMP_DISTANCE);
  }

  function jumpToLatest(): void {
    sendAnchor = null;
    readingAfterSend = false;
    readerAtEnd = true;
    const events = runtime.events();
    const newest = events.reduce((latest, event) => Math.max(latest, event.seq), 0);
    const selectedId = runtime.selectedId();
    const detailCursor = runtime.detailCursor();
    if (runtime.historyBefore() !== null && selectedId !== null && detailCursor !== null && newest + 1 < detailCursor) {
      runtime.setHistoryBefore(null);
      runtime.setDetailFor(null);
      runtime.loadDetail();
      return;
    }
    const pane = $('chatBody');
    $('timelineContent').style.removeProperty('--timeline-scroll-reserve');
    scrollPane(pane, pane.scrollHeight, true);
  }

  function readTimeline(): void {
    readerAtEnd = false;
    sendAnchor = null;
    readingAfterSend = true;
  }

  function releaseSendHold(): void {
    sendAnchor = null;
    readingAfterSend = true;
  }

  return {
    get sendAnchor() { return sendAnchor; },
    set sendAnchor(value: ChatSendAnchor | null) { sendAnchor = value; },
    get readingAfterSend() { return readingAfterSend; },
    set readingAfterSend(value: boolean) { readingAfterSend = value; },
    get readerAtEnd() { return readerAtEnd; },
    set readerAtEnd(value: boolean) { readerAtEnd = value; },
    userMessageKeys,
    holdSentMessage,
    distanceFromTail,
    timelineShown,
    paintJumpLatest,
    jumpToLatest,
    readTimeline,
    releaseSendHold
  };
}
