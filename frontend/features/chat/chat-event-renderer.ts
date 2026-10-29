import { MAX_INPUT_IMAGES, type InputAttachment, type InputImage } from '../../../contracts/input.js';
import { TURN_OUTCOME_LABELS, type SessionEvent, type SessionSummary } from '../../../contracts/session.js';
import { WEB_PROVIDERS, providerForConversationId } from '../../../contracts/web-providers.js';
import { messageReaction } from '../../../contracts/chat/reaction-content.js';
import { stripWebChatTools } from '../../../contracts/chat-protocol.js';
import { userPromptText } from '../../../contracts/messaging/provider-message-envelope.js';
import { recoveryMessage } from '../../../contracts/recovery.js';
import { $, compactNumber, el, icon, run, setIcon, toast } from '../../shared/dom.js';
import { ui, t } from '../../shared/i18n.js';
import { imageStorageButton } from './image-storage-control.js';
import { chatErrorPresentation } from './chat-error.js';
import { preserveTimelineViewport } from './timeline-scroll.js';
import { communicationTitle, workerAvatar } from '../agents/agent-communication.js';
import { renderedMarkdown, textBlock } from './markdown-renderer.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import { createToolCallRenderer } from './tool-call-renderer.js';
export { KIND_ICON } from './tool-call-renderer.js';

// Renders recorded chat events and their local actions.
export interface ChatEventContext { id: string; current: () => boolean; history: readonly SessionEvent[]; }

export interface ChatEventRendererRuntime {
  $: typeof $;
  el: typeof el;
  icon: typeof icon;
  run: typeof run;
  setIcon: typeof setIcon;
  toast: typeof toast;
  t: typeof t;
  ui: typeof ui;
  api: typeof window.api;
  selectedLocalProject: () => LocalProject | null;
  openReview: (projectId: string, sessionId: string, callId: string, indices: number[]) => Promise<boolean>;
  openWorkerChat: (sessionId: string) => void;
  readonly sessions: readonly SessionSummary[];
  readonly selectedId: string | null;
  readonly selectionGeneration: number;
  readonly events: readonly SessionEvent[];
  readonly startingInputs: ReadonlyMap<string, InputEntry>;
  readonly pendingComposerInputs: readonly InputEntry[];
  loadDetail(): void | Promise<unknown>;
  refreshInputQueue(): void | Promise<void>;
  openTools: Set<string>;
}

export function createChatEventRenderer(runtime: ChatEventRendererRuntime) {
  const { $, el, icon, run, setIcon, toast, t, ui, api } = runtime;
  const openTools = runtime.openTools;
    const agentPanel = { open: runtime.openWorkerChat };
  const toolCalls = createToolCallRenderer(runtime);

  function interruptedRequest(history: readonly SessionEvent[], stopped: Extract<SessionEvent, { kind: 'turn_end' }>): string {
    const beforeEnd = history.filter(row => row.seq <= stopped.seq);
    const startIndex = stopped.turnId
      ? beforeEnd.findLastIndex(row => row.kind === 'turn_start' && row.turnId === stopped.turnId)
      : -1;
    const candidates = (startIndex >= 0 ? beforeEnd.slice(0, startIndex) : beforeEnd).toReversed();
    const question = candidates.find((row): row is Extract<SessionEvent, { kind: 'user_message' }> => row.kind === 'user_message');
    return question ? (userPromptText(question.message.text) ?? question.message.text).trim() : '';
  }

  async function continueStoppedTurn(stopped: Extract<SessionEvent, { kind: 'turn_end' }>, context: ChatEventContext,
    button: HTMLButtonElement): Promise<void> {
    if (button.disabled || !context.current() || runtime.selectedId !== context.id) return;
    const session = runtime.sessions.find(row => row.id === context.id);
    const question = interruptedRequest(context.history, stopped);
    if (!session?.projectId || !question) return;
    button.disabled = true;
    const result = await run(api.sendInput({
      id: crypto.randomUUID(),
      sessionId: session.id,
      projectId: session.projectId,
      text: recoveryMessage(question),
      authoredSource: 'text',
      mode: 'auto',
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    }));
    if (!result) {
      button.disabled = false;
      return;
    }
    await runtime.refreshInputQueue();
    await runtime.loadDetail();
  }

  function attachmentUploadStatus(status?: 'uploading' | 'ready' | 'failed'): HTMLElement | null {
    if (!status) return null;
    const label = status === 'uploading' ? t('Uploading…') : status === 'ready' ? t('Uploaded') : t('Upload failed');
    const badge = el('span', `attachment-upload-status is-${status}`);
    badge.dataset.status = status;
    badge.setAttribute('aria-live', 'polite');
    const statusIcon = status === 'uploading'
      ? el('span', 'attachment-loading-spinner is-small')
      : el('i', `ico ph ${status === 'ready' ? 'ph-check-circle' : 'ph-warning-circle'}`);
    statusIcon.setAttribute('aria-hidden', 'true');
    badge.append(statusIcon, el('span', status === 'uploading' ? 'attachment-loading-label' : '', label));
    return badge;
  }
  function attachmentCard(file: InputAttachment, inComposer = false, uploadStatus?: 'uploading' | 'ready' | 'failed'): HTMLElement {
    if (file.preview) {
      const image = document.createElement('img'); image.src = file.preview; image.alt = file.name; image.title = file.name;
      if (!inComposer) {
        const tile = el('div', 'attachment-image-card');
        tile.append(image);
        const status = attachmentUploadStatus(uploadStatus);
        if (status) tile.append(status);
        return tile;
      }
      const tile = el('div', 'composer-image');
      tile.append(image);
      const status = attachmentUploadStatus(uploadStatus);
      if (status) tile.append(status);
      return tile;
    }
    const tile = el('div', 'attachment-card'); tile.title = file.name;
    const glyph = el('span', `attachment-icon${uploadStatus === 'uploading' ? ' is-loading' : ''}`);
    const fileGlyph = uploadStatus === 'uploading' ? el('span', 'attachment-loading-spinner') : icon('i-file-text');
    fileGlyph.setAttribute('aria-hidden', 'true');
    glyph.append(fileGlyph);
    const details = el('div', 'attachment-details');
    const kind = el('div', 'attachment-kind');
    if (uploadStatus === 'uploading') kind.append(el('span', 'attachment-loading-label', t('Uploading…')));
    else kind.textContent = file.mimeType.startsWith('image/') ? t("Image") : t("File");
    details.append(el('div', 'attachment-name', file.name), kind);
    const status = uploadStatus === 'uploading' ? null : attachmentUploadStatus(uploadStatus);
    if (status) details.append(status);
    tile.append(glyph, details); return tile;
  }
  // The exact outbox input retains preview bytes until optional history storage succeeds.
  function retainedInputImages(event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string | null): InputImage[] {
    if (!sessionId || !event.inputId) return [];
    const root = [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].find(entry => entry.id === event.inputId &&
      (entry.sessionId ?? entry.deliveredSessionId) === sessionId &&
      (entry.messageId ? entry.messageId === event.messageId : event.messageId === `input:${entry.id}`));
    if (!root) return [];
    const companion = root.companionInputId ? runtime.pendingComposerInputs.find(entry => entry.id === root.companionInputId &&
      (entry.sessionId ?? entry.deliveredSessionId) === sessionId && entry.messageId === root.messageId) : undefined;
    // Match combinedInput's canonical image order for asset-index fallback.
    return [...root.images ?? [], ...companion?.images ?? [], ...root.toolImages ?? []].slice(0, MAX_INPUT_IMAGES);
  }
  function paintMessageReaction(box: HTMLElement, value: unknown): void {
    const reaction = messageReaction(value);
    const existing = box.querySelector<HTMLElement>('.message-reaction');
    if (!reaction) { existing?.remove(); return; }
    if (existing?.textContent === reaction) return;
    const badge = existing ?? el('span', 'message-reaction');
    badge.textContent = reaction;
    badge.setAttribute('role', 'img');
    ui(badge, 'aria-label', () => t("{0} reacted with {1}", [providerLabelForSession(), reaction]));
    if (!existing) box.append(badge);
  }
  function providerLabelForSession(sessionId = runtime.selectedId): string {
    const conversationId = runtime.sessions.find(row => row.id === sessionId)?.conversationId;
    const provider = conversationId ? providerForConversationId(conversationId) : null;
    return provider ? WEB_PROVIDERS[provider].label : 'NEURAFLOK';
  }
  function eventBody(event: SessionEvent, context?: { id: string; current: () => boolean; history: readonly SessionEvent[] }): HTMLElement {
    switch (event.kind) {
      case 'session_start':
        return el('p', 'meta', () => t("Session started — {0}", [event.title]));
      case 'user_message': {
        const box = el('div', 'said is-user');
        box.classList.add('has-reaction-slot');
        box.append(el('b', '', () => t("You")));
        const attachments = el('div', 'message-attachments');
        if (event.attachments?.length) attachments.append(...event.attachments.map(file => attachmentCard(file, false, event.attachmentUpload)));
        const assets = event.assets?.filter(asset => asset.mimeType === 'image/webp').slice(0, MAX_INPUT_IMAGES) ?? [];
        const retained = retainedInputImages(event, context?.id ?? runtime.selectedId);
        const preview = (data: string, retainedOnly = false, slot?: HTMLElement) => {
          const image = document.createElement('img');
          image.src = data; image.alt = t("User attachment"); image.loading = 'lazy';
          const frame = slot ?? el('div', 'user-image-slot');
          frame.replaceChildren(image);
          if (!slot) attachments.append(frame);
          if (retainedOnly) {
            const notice = el('span', 'retained-image-notice', () => t("Not saved to history"));
            ui(notice, 'title', () => t("Image preview retained with this delivery; not yet saved to history."));
            frame.append(notice);
          }
        };
        // History selection measures the viewport before IPC completes. Reserve each saved image's final footprint now; loading, pixels and failure all occupy the same slot.
        const slots = assets.map(() => {
          const slot = el('div', 'user-image-slot');
          slot.append(el('span', 'meta', () => t("Image preview is loading")));
          attachments.append(slot);
          return slot;
        });
        if (event.attachments?.length || assets.length || retained.length) box.append(attachments);
        if (!assets.length) for (const image of retained) preview(image.dataUrl, true);
        // A provider page can prepend a blank paragraph; ignore it only after the full instruction frame validates.
        const userText = event.authoredText ?? userPromptText(event.message.text.trimStart()) ?? event.message.text;
        if (userText) box.append(textBlock('msg user-message-text', userText, event.authoredText === undefined && event.message.truncated, event.authoredText?.length ?? event.message.chars));
        paintMessageReaction(box, event.reaction);
        if (event.inputDelivery) {
          box.classList.add('has-input-receipt');
          const receipt = el('span', 'input-receipt');
          const label = event.inputDelivery === 'offered' ? t("Sent to the active turn · awaiting receipt") : t("Delivery confirmed");
          receipt.title = label; receipt.setAttribute('aria-label', label);
          receipt.append(icon(event.inputDelivery === 'offered' ? 'i-clock' : 'i-check'));
          box.append(receipt);
        }
        if (assets.length && (context?.id || runtime.selectedId)) {
          const id = context?.id ?? runtime.selectedId!, generation = runtime.selectionGeneration;
          void (async () => {
            for (const [index, asset] of assets.entries()) {
              const data = await run(api.getSessionImage(id, asset.id));
              if (context ? !context.current() : id !== runtime.selectedId || generation !== runtime.selectionGeneration) return;
              const slot = slots[index]!;
              if (data) preview(data, false, slot);
              else if (retained[index]) preview(retained[index]!.dataUrl, true, slot);
              else slot.replaceChildren(el('span', 'meta', () => t("Image unavailable")));
            }
          })();
        }
        return box;
      }
      case 'assistant_message': {
        const box = el('div', 'said');
        const providerLabel = providerLabelForSession(context?.id ?? runtime.selectedId);
        box.append(el('b', '', () => event.final ? providerLabel : t('{0} · partial response', [providerLabel])));
        const visibleText = stripWebChatTools(event.message.text);
        if (visibleText.trim()) box.append(renderedMarkdown(visibleText));
        else box.hidden = true;
        return box;
      }
      case 'native_image': {
        const box = el('div', 'said native-image');
        box.append(el('b', '', () => t('Generated image')));
        const frame = el('div', 'generated-image-frame');
        const width = event.width ?? event.previewWidth ?? 1;
        const height = event.height ?? event.previewHeight ?? 1;
        frame.style.aspectRatio = `${Math.max(1, width)} / ${Math.max(1, height)}`;
        const unavailable = () => {
          frame.classList.toggle('is-unavailable', event.previewStatus !== 'pending');
          frame.replaceChildren(el('p', 'meta', () => {
          if (event.previewStatus === 'pending') return t("Image preview is loading");
          if (event.previewError === 'removed') return t("Image removed from local storage");
          if (event.previewError === 'quota') return t("Image preview unavailable — recording storage is full");
          if (event.previewError === 'oversized') return t("Image preview unavailable — image exceeds the recording limit");
          return t("Image preview unavailable");
          }));
          if (event.previewStatus !== 'pending') frame.append(imageStorageButton());
        };
        if (event.asset) frame.append(el('p', 'meta', () => t("Image preview is loading")));
        else unavailable();
        box.append(frame);
        const id = context?.id ?? runtime.selectedId;
        if (event.asset && id) {
          const generation = runtime.selectionGeneration;
          void (async () => {
            const data = await run(api.getSessionImage(id, event.asset!.id));
            if (context ? !context.current() : id !== runtime.selectedId || generation !== runtime.selectionGeneration) return;
            if (!data) {
              const pane = context ? box.closest<HTMLElement>('.agent-panel-body') : $('chatBody');
              const timeline = context ? pane : $('timelineContent');
              const restore = pane && timeline && box.isConnected ? preserveTimelineViewport(pane, timeline) : () => {};
              unavailable(); restore();
              return;
            }
            const image = document.createElement('img');
            image.src = data;
            image.alt = t('Generated image');
            frame.replaceChildren(image);
          })();
        }
        return box;
      }
      case 'progress': {
        return el('p', 'meta is-progress', event.message.text);
      }
      case 'page_tool': {
        const line = el('p', 'meta is-progress thinking-line');
        line.append(icon('i-globe', 'ico thinking-ico'), el('span', '', event.label));
        return line;
      }
      case 'turn_start':
        return el('p', 'meta', () => event.detail ? t("Turn reopened — {0}", [event.detail]) : t("Turn started"));
      case 'turn_end': {
        if (stoppedTurnEnd(event, context?.history ?? runtime.events)) {
          const line = el('p', 'meta is-progress thinking-line turn-stopped');
          line.append(icon('i-check-circle', 'ico thinking-ico'), el('span', '', () => t('Stopped. The provider page no longer shows this turn running.')));
          const history = context?.history ?? runtime.events;
          const session = context ? runtime.sessions.find(row => row.id === context.id) : undefined;
          const hasPendingInput = runtime.pendingComposerInputs.some(row => row.sessionId === context?.id &&
            ['queued', 'browser', 'tool'].includes(row.state));
          const question = interruptedRequest(history, event);
          if (context && context.id === runtime.selectedId && session?.projectId && question && !hasPendingInput) {
            const resume = el('button', 'turn-stopped-continue', () => t('Continue')) as HTMLButtonElement;
            resume.type = 'button';
            resume.onclick = () => { void continueStoppedTurn(event, context, resume); };
            line.append(resume);
          }
          return line;
        }
        const line = el(
          'p',
          event.outcome === 'completed' ? 'meta' : 'meta is-warn',
          () => t("Turn {0}{1}", [t(TURN_OUTCOME_LABELS[event.outcome]), event.detail ? ` — ${event.detail}` : ''])
        );
        return line;
      }
      case 'chat_error': {
        const notice = el('div', 'chat-error-notice');
        notice.setAttribute('role', 'status');
        const presentation = () => chatErrorPresentation(event, context?.history ?? runtime.events);
        // The timeline signature includes this projection, so later completion/work repaints it.
        notice.classList.toggle('is-resolved', presentation().resolved);
        notice.classList.toggle('is-reloaded', presentation().reloaded);
        const title = el('strong', '', () => presentation().title);
        notice.append(title, textBlock('msg', presentation().message, event.message.truncated, event.message.chars),
          el('p', 'chat-error-next', () => presentation().next));
        return notice;
      }
      case 'tool_call':
        return toolCalls.toolBody(event, context);
      case 'note':
        return el('p', 'meta', event.message.text);
      // Rendered rather than left to fall through to "Unknown event". The timeline is how the user checks what the agents actually said to each other, and a run of grey "Unknown event" rows in the middle of a multi-agent session reads as a broken log — the one impression a session recorder cannot afford to give.
      case 'agent_message': {
        const box = document.createElement('details');
        box.className = 'agent-communication';
        // Which end of the message this record is. The same message is written once here and once in the other agent's session, so without this a pair reads as two messages.
        ui(box, 'title', () => event.delivery === 'sent'
            ? t("Sent by {0}; recorded when the app accepted it", [event.from])
            : t("Received by {0}; recorded when it acknowledged delivery", [event.to]));
        const summary = el('summary');
        const worker = event.from === 'prime' ? event.to : event.from;
        const avatar = workerAvatar(worker);
        summary.append(avatar, el('span', '', () => communicationTitle(event)));
        const communicationKey = `agent:${context?.id ?? runtime.selectedId}:${event.seq}`;
        box.open = openTools.has(communicationKey);
        box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
        box.append(summary);
        box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
        if (!context) {
          const matches = runtime.sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === runtime.selectedId && entry.origin.agentId === worker);
          if (matches.length === 1) {
            const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
            ui(open, 'aria-label', () => t("Open {0} chat", [worker]));
            const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
            open.append(el('span', '', () => t("Open worker chat")), arrow);
            open.onclick = () => void agentPanel?.open(matches[0]!.id); box.append(open);
          }
        }
        return box;
      }
      case 'handoff':
        return el(
          'p',
          'meta is-good',
          () => t("Handoff saved — {0} characters ({1})", [compactNumber(event.chars), event.reason])
        );
      default:
        return el('p', 'meta', () => t("Unknown event"));
    }
  }
  // Copy and Markdown export under the answer of a turn the page reported as completed. Main builds the text from the log, reading back answers that were cut there, so a long answer copies and exports whole; the timeline only decides where the actions appear.
  function answerActions(turnId: string): HTMLElement {
    const bar = el('div', 'answer-actions');
    const sessionId = runtime.selectedId;
    const exportTo = async (scope: 'answer' | 'session', target: 'clipboard' | 'file') => {
      if (!sessionId || runtime.selectedId !== sessionId) return null;
      return run(api.exportMarkdown({ id: sessionId, scope, turnId: scope === 'answer' ? turnId : undefined, target }));
    };
    const copy = el('button', 'answer-action') as HTMLButtonElement;
    copy.type = 'button';
    const copyGlyph = icon('i-copy');
    copy.append(copyGlyph);
    ui(copy, 'title', () => t('Copy answer')); ui(copy, 'aria-label', () => t('Copy answer'));
    let copiedTimer: number | undefined;
    copy.addEventListener('click', async () => {
      const result = await exportTo('answer', 'clipboard');
      if (result?.done !== 'copied') return;
      setIcon(copyGlyph, 'i-check'); copy.classList.add('is-done');
      window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => { setIcon(copyGlyph, 'i-copy'); copy.classList.remove('is-done'); }, 1500);
    });
    const menu = document.createElement('details');
    menu.className = 'answer-export';
    const trigger = el('summary', 'answer-action');
    trigger.append(icon('i-export'));
    ui(trigger, 'title', () => t('Export as Markdown')); ui(trigger, 'aria-label', () => t('Export as Markdown'));
    const choices = el('div', 'answer-export-menu');
    for (const [scope, label] of [['answer', 'This answer'], ['session', 'Whole session']] as const) {
      const choice = el('button', 'answer-export-choice', () => t(label)) as HTMLButtonElement;
      choice.type = 'button';
      choice.addEventListener('click', async () => {
        menu.open = false;
        const result = await exportTo(scope, 'file');
        if (result?.done === 'saved') toast(t('Saved {0}', [result.name]));
      });
      choices.append(choice);
    }
    menu.append(trigger, choices);
    const close = (event: Event) => { if (menu.open && !menu.contains(event.target as Node)) menu.open = false; };
    menu.addEventListener('toggle', () => {
      if (menu.open) document.addEventListener('pointerdown', close, true);
      else document.removeEventListener('pointerdown', close, true);
    });
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; trigger.focus(); } });
    bar.append(copy, menu);
    return bar;
  }
  // A turn's stopped end, while it is still that turn's last word: the line that says it stopped. The app's Stop note stays where Stop was asked (finish.ts) and says what was known then. The end of the turn is where it stopped: the page's stopped end, after every call the turn made. Late work can reopen the turn (recorder.ts); that end then stops being the last word, and the next stopped end, after the late work, says it again.
  function stoppedTurnEnd(event: SessionEvent, history: readonly SessionEvent[]): boolean {
    if (event.kind !== 'turn_end' || event.outcome !== 'stopped' || !event.turnId) return false;
    return !history.some(later => later.seq > event.seq && later.turnId === event.turnId &&
      (later.kind === 'turn_start' || later.kind === 'turn_end'));
  }
    return { attachmentCard, eventBody, answerActions, retainedInputImages, paintMessageReaction, stoppedTurnEnd };
}
