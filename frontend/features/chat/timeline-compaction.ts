import { continuationMarkerOf, type SessionEvent } from '../../../contracts/session.js';
import { currentLanguage, ui, t } from '../../shared/i18n.js';
import { clockTime, compactNumber, el, icon } from '../../shared/dom.js';
import { userPromptText } from '../../../contracts/messaging/provider-message-envelope.js';
import { renderedMarkdown, textBlock } from './markdown-renderer.js';
import { isHandshakeAck } from './chat-composer-ready.js';

export interface CompactionTimelineRuntime {
  el: typeof el;
  icon: typeof icon;
  ui: typeof ui;
  t: typeof t;
  openTools: Set<string>;
  reconcileChildren: (parent: Element, children: HTMLElement[]) => void;
}

// Compaction rows group Compact & Resume events under their durable continuation token.
export interface CompactionBlock {
  token: string;
  seq: number;
  time: number;
  prompt: Extract<SessionEvent, { kind: 'user_message' }> | null;
  turnId: string | null;
  brief: Extract<SessionEvent, { kind: 'assistant_message' }> | null;
  end: Extract<SessionEvent, { kind: 'turn_end' }> | null;
  handoff: Extract<SessionEvent, { kind: 'handoff' }> | null;
  resume: Extract<SessionEvent, { kind: 'user_message' }> | null;
  notes: Array<Extract<SessionEvent, { kind: 'note' }>>;
}

export type TimelineItem = { kind: 'event'; event: SessionEvent } | { kind: 'compaction'; block: CompactionBlock };

type CompactionTone = 'good' | 'wait' | 'bad';
const ABANDONED_NOTE = /^Compact & Resume abandoned\s*[\u2014-]\s*/i;

export function createTimelineCompaction(runtime: CompactionTimelineRuntime) {
  const { el, icon, ui, t, openTools, reconcileChildren } = runtime;
  function continuationMarker(event: SessionEvent): { kind: 'HANDOFF' | 'RESUME'; token: string } | null {
    if (event.kind !== 'user_message') return null;
    const match = continuationMarkerOf(event.message.text);
    return match ? { kind: match.kind, token: match.token } : null;
  }
  // Fold each compaction handoff and its resumed turn into one timeline card keyed by its durable token.
  function timelineItems(source: SessionEvent[]): TimelineItem[] {
    const items: TimelineItem[] = [];
    const blocks = new Map<string, CompactionBlock>();
    let open: CompactionBlock | null = null;
    const blockFor = (token: string, event: SessionEvent): CompactionBlock => {
      let block = blocks.get(token);
      if (!block) {
        block = {
          token,
          seq: event.seq,
          time: event.time,
          prompt: null,
          turnId: null,
          brief: null,
          end: null,
          handoff: null,
          resume: null,
          notes: []
        };
        blocks.set(token, block);
        items.push({ kind: 'compaction', block });
      }
      return block;
    };
    for (const event of source) {
      if (event.kind === 'assistant_message' && isHandshakeAck(event.message.text)) continue;
      const marker = continuationMarker(event);
      if (marker && event.kind === 'user_message') {
        const block = blockFor(marker.token, event);
        if (marker.kind === 'HANDOFF') {
          block.prompt = event;
          block.turnId = event.turnId ?? null;
          open = block;
          // Chronology puts a turn's start before the message that opened it, so the request turn's own start row is already on the list; it belongs to the card like the rest.
          const previous = items[items.length - 2];
          if (
            previous?.kind === 'event' &&
            previous.event.kind === 'turn_start' &&
            event.turnId !== undefined &&
            previous.event.turnId === event.turnId
          ) {
            items.splice(items.length - 2, 1);
          }
        } else {
          block.resume = event;
          if (open === block) open = null;
        }
        continue;
      }
      if (event.kind === 'note' && event.continuation) {
        const block = blockFor(event.continuation, event);
        block.notes.push(event);
        if (open === block) open = null;
        continue;
      }
      if (open) {
        if (event.kind === 'handoff') {
          open.handoff = event;
          continue;
        }
        if (event.kind === 'assistant_message') {
          if (open.turnId && event.turnId && event.turnId !== open.turnId) {
            items.push({ kind: 'event', event });
            continue;
          }
          open.brief = event;
          if (event.turnId !== undefined) open.turnId = event.turnId;
          continue;
        }
        if (event.kind === 'turn_start' && !open.brief && !open.handoff && !open.end) {
          open.turnId = event.turnId ?? null;
          continue;
        }
        const sameTurn = open.turnId !== null && event.turnId === open.turnId;
        if (sameTurn && (event.kind === 'turn_end' || event.kind === 'progress' || event.kind === 'page_tool')) {
          if (event.kind === 'turn_end') open.end = event;
          continue;
        }
        // Local calls can finish or be refused after the source request. They remain ordinary visible rows and cannot close the summary's grouping or decide its fate. Only another authored user message starts an unrelated conversation step.
        if (event.kind === 'user_message') open = null;
      }
      items.push({ kind: 'event', event });
    }
    return items;
  }
  // One sentence for where the compaction is, or where it died. Success and failure come from the recorded continuation, never from later activity in this timeline. Refused source calls are compatible with a still-running handoff.
  function compactionState(block: CompactionBlock): { text: string; tone: CompactionTone } {
    const chars = block.handoff ? t(" ({0} characters)", [compactNumber(block.handoff.chars)]) : '';
    if (block.resume) return { text: t("New chat opened at {0}{1}", [clockTime(block.resume.time), chars]), tone: 'good' };
    const abandoned = [...block.notes].reverse().find((note) => ABANDONED_NOTE.test(note.message.text));
    if (abandoned) return { text: t("Failed — {0}", [abandoned.message.text.replace(ABANDONED_NOTE, '')]), tone: 'bad' };
    if (block.handoff) {
      return { text: t("Summary saved{0} — opening the new chat…", [chars]), tone: 'wait' };
    }
    if (block.end && block.end.outcome !== 'completed') {
      const status = block.end.outcome === 'stopped' ? t("Summary generation stopped")
        : block.end.outcome === 'failed' ? t("Summary generation failed")
        : t("Summary generation ended without a completed handoff");
      return { text: block.end.detail ? t("{0} — {1}", [status, block.end.detail]) : status, tone: 'bad' };
    }
    if (block.brief?.final) {
      return { text: t("Summary written — saving the handoff…"), tone: 'wait' };
    }
    if (block.brief) return { text: t("The provider is writing the summary…"), tone: 'wait' };
    return { text: t("Summary requested — waiting for the provider…"), tone: 'wait' };
  }
  function compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
    const key = `compaction:${block.token}`;
    const state = compactionState(block);

    const row = previous ?? el('div', 'ev ev-compaction');
    const box = previous?.querySelector<HTMLDetailsElement>('details.compaction') ?? document.createElement('details');
    box.className = `tool compaction tone-${state.tone}`;
    if (!previous) {
      box.open = openTools.has(key);
      box.addEventListener('toggle', () => {
        if (box.open) openTools.add(key);
        else openTools.delete(key);
      });
    }

    if (!previous) {
      const head = document.createElement('summary');
      head.append(icon('i-steps', 'ico tool-ico'));
      head.append(el('b', '', () => t("Compact & Resume:")));
      head.append(el('span', 'state'));
      box.append(head);
    }
    ui(box.querySelector<HTMLElement>('summary .state')!, 'textContent', () => compactionState(block).text);

    const raw = el('div', 'raw');
    if (block.prompt) {
      raw.append(el('h4', '', () => t("Brief request")));
      // The routing marker is the app's, not the user's; the card already says what this is.
      const prompt = userPromptText(block.prompt.message.text) ?? block.prompt.message.text;
      // The marker is stripped in whichever form the page recorded it; `marker` is the exact text that matched, so an escaped one is removed as completely as a clean one.
      const request = prompt.replace(continuationMarkerOf(prompt)?.marker ?? '', '');
      raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
    }
    if (block.brief) {
      const brief = block.brief;
      raw.append(el('h4', '', () => brief.final ? t("Summary") : t("Summary (still writing)")));
      raw.append(renderedMarkdown(block.brief.message.text));
    }
    if (block.handoff) {
      const saved = block.handoff;
      raw.append(
        el('p', 'raw-facts', () => t("Handoff saved — {0} characters ({1})", [compactNumber(saved.chars), saved.reason]))
      );
    }
    if (block.resume) {
      const resumed = block.resume;
      raw.append(
        el(
          'p',
          'raw-facts',
          () => t("Bootstrap sent into the new chat — {0} characters at {1}", [compactNumber(resumed.message.chars), clockTime(resumed.time)])
        )
      );
    }
    for (const note of block.notes) raw.append(el('p', 'raw-facts', `${clockTime(note.time)} — ${note.message.text}`));
    const oldRaw = box.querySelector<HTMLElement>('.raw');
    if (oldRaw) {
      // Streaming changes only the affected section. Keep the disclosure, focus and unchanged request mounted instead of replacing the whole reading surface.
      const oldParts = [...oldRaw.children];
      reconcileChildren(oldRaw, [...raw.children].map((part, index) =>
        (oldParts[index]?.isEqualNode(part) ? oldParts[index] : part) as HTMLElement));
    } else box.append(raw);

    if (previous) return row;
    const time = document.createElement('time');
    time.textContent = clockTime(block.time);
    time.title = new Date(block.time).toLocaleString(currentLanguage());
    const body = el('div', 'ev-body');
    body.append(box);
    row.append(time, body);
    return row;
  }
  return { timelineItems, compactionRow };
}
