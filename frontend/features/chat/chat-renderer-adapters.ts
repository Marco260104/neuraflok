import type { InputAttachment, InputImage } from '../../../contracts/input.js';
import type { SessionEvent } from '../../../contracts/session.js';
import type { ChatEventContext, createChatEventRenderer } from './chat-event-renderer.js';
import type { CompactionBlock, createTimelinePresentation, TimelineItem } from './timeline-presentation.js';

type ChatEventRenderer = ReturnType<typeof createChatEventRenderer>;
type TimelinePresentation = ReturnType<typeof createTimelinePresentation>;

export function createChatRendererAdapters(
  eventRenderer: () => ChatEventRenderer,
  timelineView: () => TimelinePresentation
) {
  return {
    eventBody(event: SessionEvent, context?: ChatEventContext): HTMLElement {
      return eventRenderer().eventBody(event, context);
    },
    attachmentCard(file: InputAttachment, inComposer = false): HTMLElement {
      return eventRenderer().attachmentCard(file, inComposer);
    },
    answerActions(turnId: string): HTMLElement {
      return eventRenderer().answerActions(turnId);
    },
    retainedInputImages(event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string | null): InputImage[] {
      return eventRenderer().retainedInputImages(event, sessionId);
    },
    paintMessageReaction(box: HTMLElement, value: unknown): void {
      eventRenderer().paintMessageReaction(box, value);
    },
    stoppedTurnEnd(event: SessionEvent, history: readonly SessionEvent[]): boolean {
      return eventRenderer().stoppedTurnEnd(event, history);
    },
    timelineItems(source: SessionEvent[]): TimelineItem[] {
      return timelineView().timelineItems(source);
    },
    itemKey(item: TimelineItem): string {
      return timelineView().itemKey(item);
    },
    itemSignature(item: TimelineItem): string {
      return timelineView().itemSignature(item);
    },
    eventRow(event: SessionEvent): HTMLElement {
      return timelineView().eventRow(event);
    },
    compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
      return timelineView().compactionRow(block, previous);
    },
    reconcileChildren(parent: Element, children: HTMLElement[]): void {
      timelineView().reconcileChildren(parent, children);
    },
    renderRounds(rows: HTMLElement[], working: boolean, scope: string | null,
      groups: Map<string, HTMLElement>, workerBadges: boolean): HTMLElement[] {
      return timelineView().renderRounds(rows, working, scope, groups, workerBadges);
    },
    tagImageRow(row: HTMLElement, event: SessionEvent): void {
      timelineView().tagImageRow(row, event);
    },
    groupImageRows(rows: HTMLElement[]): HTMLElement[] {
      return timelineView().groupImageRows(rows);
    },
    paintInputReceipt(row: HTMLElement, item: TimelineItem): void {
      timelineView().paintInputReceipt(row, item);
    },
    hasLaterModelActivity(time: number): boolean {
      return timelineView().hasLaterModelActivity(time);
    }
  };
}
