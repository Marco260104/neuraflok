import type { SessionEvent } from '../../../contracts/session.js';
import { currentLanguage, ui, t } from '../../shared/i18n.js';
import { clockTime, disclosureChevron, el, icon } from '../../shared/dom.js';
import { withoutMessageReaction } from '../../../contracts/chat/reaction-content.js';
import { stripWebChatTools } from '../../../contracts/chat-protocol.js';
import { structureTimeline, type RoundPart } from './timeline-rounds.js';
import { createTimelineCompaction, type TimelineItem } from './timeline-compaction.js';
import type { InputImage } from '../../../contracts/input.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { ChatEventContext } from './chat-event-renderer.js';
export type { CompactionBlock, TimelineItem } from './timeline-compaction.js';

// Builds reusable timeline rows, compaction cards, and round groupings.
export interface TimelinePresentationRuntime {
  el: typeof el;
  icon: typeof icon;
  ui: typeof ui;
  t: typeof t;
  readonly selectedId: string | null;
  readonly selectionGeneration: number;
  readonly sessions: readonly SessionSummary[];
  readonly events: readonly SessionEvent[];
  readonly roundsEnter: boolean;
  canonicalMessageKey: (event: SessionEvent) => string | null;
  openTools: Set<string>;
  rowEvents: WeakMap<HTMLElement, SessionEvent>;
  turnNow: HTMLElement;
  eventBody: (event: SessionEvent, context?: ChatEventContext) => HTMLElement;
  retainedInputImages: (event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string | null) => InputImage[];
  showWorkers: (ids: string[], focus: boolean) => void;
  readTimeline: () => void;
  paintJumpLatest: () => void;
}

export function createTimelinePresentation(runtime: TimelinePresentationRuntime) {
  const { el, icon, ui, t, openTools, rowEvents, turnNow } = runtime;
  const eventBody = runtime.eventBody;
  const retainedInputImages = runtime.retainedInputImages;
  const agentPanel = { showWorkers: runtime.showWorkers };
  const readTimeline = runtime.readTimeline;
  const paintJumpLatest = runtime.paintJumpLatest;
  const compaction = createTimelineCompaction({ el, icon, ui, t, openTools, reconcileChildren });
  function roundWorkers(ids: string[], button = el('button', 'activity-workers') as HTMLButtonElement): HTMLButtonElement {
    button.type = 'button';
    button.hidden = ids.length === 0;
    const label = () => ids.length === 1 ? t('1 sub-agent in this round') : t('{0} sub-agents in this round', [ids.length]);
    ui(button, 'title', label);
    ui(button, 'aria-label', label);
    // One pill whatever the count, in the same family as the round's action count beside it.
    if (!button.childElementCount) button.append(icon('i-agents'), el('span'));
    button.lastElementChild!.textContent = String(ids.length);
    const owner = runtime.selectedId, epoch = runtime.selectionGeneration;
    button.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (runtime.selectedId !== owner || runtime.selectionGeneration !== epoch || !button.isConnected) return;
      const current = ids.filter(id => runtime.sessions.some(worker => worker.id === id &&
        worker.origin?.kind === 'worker' && worker.origin.fromSessionId === owner));
      if (!current.length) return;
      readTimeline();
      // From the keyboard (a click with no pointer detail), focus follows to the round's first worker; a mouse click leaves it, so the row settles plain after its glow instead of keeping a ring.
      agentPanel?.showWorkers(current, event.detail === 0);
      paintJumpLatest();
    };
    return button;
  }
  function hasLaterModelActivity(time: number): boolean {
    return runtime.events.some(event => event.time > time && ['assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
  }
  function paintInputReceipt(row: HTMLElement, item: TimelineItem): void {
    if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
    const receipt = row.querySelector<HTMLElement>('.input-receipt');
    if (!receipt) return;
    receipt.hidden = hasLaterModelActivity(item.event.time);
    receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
  }
  function eventRow(event: SessionEvent, context?: ChatEventContext): HTMLElement {
    const row = el('div', `ev ev-${event.kind}`);
    // App-authored recovery note, not a provider progress caption.
    if (event.kind === 'progress' && event.source === 'app') row.dataset.appNote = '';
    if (event.kind === 'assistant_message' &&
        !stripWebChatTools(withoutMessageReaction(event.message.text)).trim()) row.hidden = true;
    tagImageRow(row, event);
    const time = document.createElement('time');
    time.textContent = clockTime(event.time);
    time.title = new Date(event.time).toLocaleString(currentLanguage());
    const body = el('div', 'ev-body');
    const currentWorker = runtime.sessions.find(session => session.id === runtime.selectedId)?.origin;
    if (event.agent && event.agent !== 'prime' && !(currentWorker?.kind === 'worker' && currentWorker.agentId === event.agent)) {
      body.append(el('span', 'chip', event.agent));
    }
    body.append(eventBody(event, context));
    // A refused call from a chat Compact & Resume already replaced is not a placement failure: its request id proved exactly which chat it came from, and that chat's stopped turn simply kept calling from OpenAI's side. Say so beside the row, or a full Unattributed bucket of these reads as the attribution chain having broken.
    if (event.kind === 'tool_call' && event.call.attributionMethod === 'superseded') {
      body.append(
        el(
          'p',
          'meta',
          () => t("From a conversation that Compact & Resume had already replaced — its provider kept running the stopped turn. Refused by design; nothing to repair.")
        )
      );
    }
    row.append(time, body);
    return row;
  }
  // What a row was drawn from; a different signature is a different row.
  function itemSignature(item: TimelineItem): string {
    if (item.kind === 'compaction') {
      const { block } = item;
      return [
        block.token,
        block.prompt?.seq ?? '',
        block.brief ? `${block.brief.seq}:${block.brief.message.chars}:${block.brief.state}` : '',
        block.end ? `${block.end.seq}:${block.end.outcome}:${block.end.detail ?? ''}` : '',
        block.handoff?.seq ?? '',
        block.resume?.seq ?? '',
        block.notes.map((note) => note.seq).join(',')
      ].join('|');
    }
    const { event } = item;
    const parts: Array<string | number> = [event.kind === 'user_message' ? '' : event.seq, event.time, event.kind, event.agent ?? ''];
    switch (event.kind) {
      case 'user_message': {
        // A badge-only revision patches the existing bubble, preserving loaded images and selection. Every other recorded field still invalidates its body.
        const { seq: _seq, reaction: _reaction, ...body } = event;
        parts.push(JSON.stringify(body));
        // Bytes are immutable for an accepted input. Queue arrival must repaint a canonical row even if its recorded revision did not change.
        parts.push(...retainedInputImages(event, runtime.selectedId).map(image => `${image.name}:${image.dataUrl.length}`));
        break;
      }
      case 'progress':
      case 'chat_error':
      case 'note':
      case 'agent_message':
        parts.push(event.message.chars);
        break;
      case 'assistant_message':
        parts.push(event.message.chars, event.state ?? '', event.final ? 'final' : '');
        break;
      case 'native_image':
        parts.push(event.messageId, event.providerAssetId, event.providerStatus ?? '', event.previewStatus, event.asset?.id ?? '',
          event.previewWidth ?? '', event.previewHeight ?? '', event.previewError ?? '');
        break;
      case 'tool_call':
        parts.push(
          event.call.outcome,
          event.call.attribution,
          event.call.durationMs,
          event.call.args.chars,
          event.call.result.chars,
          event.call.summary.title,
          event.call.summary.detail ?? ''
        );
        break;
      case 'page_tool':
        parts.push(event.label);
        break;
      case 'turn_end':
        parts.push(event.outcome, event.detail ?? '');
        break;
      case 'handoff':
        parts.push(event.chars);
        break;
      default:
        break;
    }
    return parts.join('|');
  }
  function itemKey(item: TimelineItem): string {
    if (item.kind === 'compaction') return `compaction:${item.block.token}`;
    if (item.event.kind === 'user_message' && item.event.inputId) return `input:${item.event.inputId}`;
    // A canonical revision advances the update cursor, not the identity of the row anchoring the viewport and the following activity disclosure.
    const message = runtime.canonicalMessageKey(item.event);
    return message ? `message:${message}` : `event:${item.event.seq}`;
  }
  // Keep retained scroll containers mounted: rebuilding a feed must not restart disclosure animations or detach a result while the user is scrolling it.
  function reconcileChildren(parent: Element, children: HTMLElement[]): void {
    const keep = new Set<Node>(children);
    for (const old of [...parent.childNodes]) if (!keep.has(old)) old.remove();
    let cursor = parent.firstChild;
    for (const child of children) {
      if (child !== cursor) parent.insertBefore(child, cursor);
      cursor = child.nextSibling;
    }
  }
  // Fold presentation noise without merging or dropping any recorded call.
  function foldRoutineActivity(rows: HTMLElement[]): HTMLElement[] {
    const result: HTMLElement[] = [];
    const retained = new Set<HTMLDetailsElement>();
    const routineTitle = (row: HTMLElement) => row.querySelector('.tool[data-outcome="ok"] > summary b')?.textContent ?? '';
    for (let i = 0; i < rows.length;) {
      const title = routineTitle(rows[i]!);
      if (title !== 'Checked agent status' && !title.startsWith('Waited on session ')) {
        result.push(rows[i++]!); continue;
      }
      let end = i + 1;
      while (end < rows.length && routineTitle(rows[end]!) === title) end++;
      if (end - i < 5) { result.push(...rows.slice(i, end)); i = end; continue; }
      const members = rows.slice(i, end);
      const previous = members.map(row => row.closest<HTMLDetailsElement>('.routine-activity'))
        .find((fold): fold is HTMLDetailsElement => !!fold && !retained.has(fold));
      const fold = previous ?? document.createElement('details');
      retained.add(fold);
      if (!previous) {
        fold.className = 'routine-activity';
        fold.open = openTools.has(`routine:${members[0]!.dataset.timelineKey}`);
        fold.addEventListener('toggle', () => {
          const key = `routine:${fold.dataset.firstKey}`;
          if (fold.open) openTools.add(key); else openTools.delete(key);
        });
        fold.append(el('summary'), el('div', 'routine-activity-body'));
      }
      fold.dataset.firstKey = members[0]!.dataset.timelineKey;
      fold.querySelector('summary')!.replaceChildren(
        el('span', 'routine-symbol', '↺'),
        el('span', 'activity-title', title),
        el('span', 'routine-count', `×${members.length}`)
      );
      reconcileChildren(fold.lastElementChild!, members);
      result.push(fold); i = end;
    }
    return result;
  }
  function enter(node: HTMLElement): void {
    if (!runtime.roundsEnter || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    node.classList.add('is-entering');
    node.addEventListener('animationend', () => node.classList.remove('is-entering'), { once: true });
  }
  // Group each round as a disclosure, using its recap when complete and its latest action while live.
  function roundGroup(part: Extract<RoundPart, { kind: 'work' }>, members: HTMLElement[], key: string,
    groups: Map<string, HTMLElement>, workerBadges: boolean): HTMLElement {
    let group = groups.get(key) as HTMLDetailsElement | undefined;
    if (!group) {
      group = document.createElement('details'); group.className = 'tool-group';
      group.dataset.timelineKey = key;
      const summary = document.createElement('summary');
      summary.append(el('span', 'activity-symbol'), el('span', 'activity-title'), el('span', 'activity-count'), disclosureChevron('ico activity-chevron'));
      group.append(summary, el('div', 'tool-group-body'));
      const opened = group;
      group.addEventListener('toggle', () => { if (opened.open) openTools.add(key); else openTools.delete(key); });
      group.open = openTools.has(key) || members.some(row => row.querySelector('details[open]'));
      groups.set(key, group);
      enter(group);
    }
    // A native step after this app's calls in its round is about that work and is done, unless the round is still running; one before any call (a web search between paragraphs) keeps the globe.
    let afterCall = false;
    for (const member of members) {
      if (member.matches('.ev-page_tool')) markNativeStep(member, afterCall && (!part.live || member !== members.at(-1)));
      else afterCall = true;
    }
    const latest = [...members].reverse().find(row => row.matches('.ev-tool_call, .ev-agent_message')) ?? members.at(-1);
    const latestHead = latest?.querySelector('.tool > summary, .agent-communication > summary, .thinking-line');
    const action = latestHead?.querySelector('b')?.textContent || latestHead?.querySelector('span:not(.agent-avatar)')?.textContent || t("Activity");
    const label = part.recap ?? action;
    const title = group.querySelector<HTMLElement>('.activity-title')!;
    if (title.textContent !== label) {
      title.classList.remove('is-entering');
      void title.offsetWidth;
      enter(title);
      title.textContent = label;
    }
    group.classList.toggle('is-live', part.live);
    group.classList.toggle('has-recap', !!part.recap);
    const count = members.length;
    group.querySelector('.activity-count')!.textContent = count > 1 ? String(count) : '';
    ui(group.querySelector('summary')!, 'title', () => t("{0} actions · {1}", [count, label]));
    // A closed round wears the check; a running one, the icon of what it is doing.
    const symbol = part.recap && !part.live ? null : latestHead?.querySelector('.ico, .agent-avatar');
    const glyph = group.querySelector('.activity-symbol')!;
    const wanted = symbol ? symbol.cloneNode(true) as Element : icon('i-check-circle', 'ico');
    if (!glyph.firstElementChild || !glyph.firstElementChild.isEqualNode(wanted)) glyph.replaceChildren(wanted);
    if (workerBadges) {
      const ids = [...new Set(members.flatMap(row => JSON.parse(row.dataset.workerSessions ?? '[]') as string[]))];
      group.dataset.workerSessions = JSON.stringify(ids);
      const links = group.querySelector<HTMLButtonElement>(':scope > summary > .activity-workers');
      if (ids.length) {
        const workers = roundWorkers(ids, links ?? undefined);
        if (!links) group.querySelector('summary')!.insertBefore(workers, group.querySelector('.activity-chevron'));
      } else links?.remove();
    }
    reconcileChildren(group.lastElementChild!, foldRoutineActivity(members));
    return group;
  }
  // Recorded provider activity is grouped around the messages that arrived with it.
  function renderRounds(rows: HTMLElement[], working: boolean, scope: string | null,
    groups: Map<string, HTMLElement>, workerBadges: boolean): HTMLElement[] {
    const keyOf = (row: HTMLElement, index: number) => row.dataset.timelineKey ?? `line:${index}`;
    const byKey = new Map(rows.map((row, index) => [keyOf(row, index), row]));
    const parts = structureTimeline(rows.map((row, index) => ({ key: keyOf(row, index), event: rowEvents.get(row), tail: row === turnNow })), working);
    const out: HTMLElement[] = [], kept = new Set<string>();
    for (const part of parts) {
      // A message read as a sentence before it was known to be the answer reads as the answer now.
      if (part.kind === 'row') { const row = byKey.get(part.key)!; row.classList.remove('is-interim'); out.push(row); continue; }
      if (part.kind === 'say') {
        const row = byKey.get(part.rowKey)!;
        row.classList.add('is-interim');
        out.push(row);
        continue;
      }
      const members = part.rows.map(key => byKey.get(key)).filter((row): row is HTMLElement => !!row);
      if (!members.length) continue;
      // One action without a recap is that action: a title over it would only repeat it.
      if (members.length === 1 && !part.recap) { markNativeStep(members[0]!, false); out.push(members[0]!); continue; }
      // Paging can extend or trim the start of a round, which moves its key; the disclosure its rows already sit in stays the same node, so neither its open state nor the reader's place moves.
      const previous = members.map(row => row.closest<HTMLElement>('.tool-group'))
        .find(group => !!group?.dataset.timelineKey && groups.get(group.dataset.timelineKey) === group && !kept.has(group.dataset.timelineKey));
      const key = previous?.dataset.timelineKey ?? `group:${scope}:${part.key}`;
      kept.add(key);
      out.push(roundGroup(part, members, key, groups, workerBadges));
    }
    for (const key of groups.keys()) if (!kept.has(key)) groups.delete(key);
    return out;
  }
  // A native provider step gets a check after the app's tool calls in its round, otherwise it gets a globe.
  function markNativeStep(row: HTMLElement, done: boolean): void {
    const line = row.querySelector<HTMLElement>('.thinking-line');
    const name = done ? 'i-check-circle' : 'i-globe';
    if (!line || (line.dataset.icon ?? 'i-globe') === name) return;
    line.dataset.icon = name;
    line.querySelector('.ico')?.replaceWith(icon(name, 'ico thinking-ico'));
  }
  // Adjacent images from one response share a compact gallery, retaining canonical rows.
  function tagImageRow(row: HTMLElement, event: SessionEvent): void {
    if (event.kind !== 'native_image') return;
    row.dataset.imageAgent = event.agent ?? '';
    row.dataset.imageMessage = event.messageId;
    row.dataset.imageTurn = event.turnId ?? '';
  }
  function groupImageRows(rows: HTMLElement[]): HTMLElement[] {
    const result: HTMLElement[] = [];
    for (let i = 0; i < rows.length;) {
      const first = rows[i]!;
      if (!first.dataset.imageMessage) { result.push(first); i++; continue; }
      const messages = new Set([first.dataset.imageMessage]);
      const turns = new Set(first.dataset.imageTurn ? [first.dataset.imageTurn] : []);
      let end = i + 1;
      while (end < rows.length) {
        const next = rows[end]!.dataset;
        if (!next.imageMessage || next.imageAgent !== first.dataset.imageAgent) break;
        if (!messages.has(next.imageMessage) && !(next.imageTurn && turns.has(next.imageTurn))) break;
        messages.add(next.imageMessage);
        if (next.imageTurn) turns.add(next.imageTurn);
        end++;
      }
      const gallery = rows.slice(i, end).map(row => row.closest<HTMLElement>('.generated-image-gallery'))
        .find((node): node is HTMLElement => !!node) ?? el('div', 'generated-image-gallery');
      reconcileChildren(gallery, rows.slice(i, end));
      result.push(gallery); i = end;
    }
    return result;
  }
  return {
    eventRow,
    groupImageRows,
    hasLaterModelActivity,
    itemKey,
    itemSignature,
    paintInputReceipt,
    reconcileChildren,
    renderRounds,
    tagImageRow,
    timelineItems: compaction.timelineItems,
    compactionRow: compaction.compactionRow
  };
}
