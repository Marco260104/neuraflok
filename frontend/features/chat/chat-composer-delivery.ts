import { injectableAttachments, type InputAttachment, type InputAutomation, type InputImage } from '../../../contracts/input.js';
import { isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { $, run } from '../../shared/dom.js';
import type { ComposerAttachment } from './chat-composer-attachments.js';
import type { ChatSendAnchor } from './chat-reader-state.js';
import { markUnboundOpening, noteOpeningSession } from './chat-composer-ready.js';

export interface ChatComposerDeliveryRuntime {
  api: Pick<typeof window.api, 'cancelInput' | 'listInputs' | 'sendInput' | 'setInputAutomation'>;
  draftKey: () => string;
  selectedId: string | null;
  sessions: SessionSummary[];
  selectedProjectId: string | null;
  imageDrafts: Map<string, ComposerAttachment[]>;
  authoredComposerText: () => string;
  selectionGeneration: number;
  controlledSessionId: string | null;
  controlledSelection: number;
  controlledTurnId: string | null;
  controlledQueueAtFinish: boolean;
  controlledCanInject: boolean;
  refreshSessionControls: () => Promise<void>;
  stopCurrentTurn: () => Promise<void>;
  pendingComposerInput: () => InputEntry | undefined;
  startingInputs: Map<string, InputEntry>;
  cancelledStarts: Set<string>;
  pendingComposerInputs: InputEntry[];
  dismissInputNotice: (id: string) => void;
  paintDeliveryControls: () => void;
  refreshInputQueue: () => Promise<void>;
  replaceComposerDraft: () => void;
  inputDrafts: Map<string, string>;
  restoreSkills: () => void | undefined;
  paintComposerImages: () => void;
  pendingNewInput: { id: string; generation: number } | null;
  followOutput: () => boolean;
  sendAnchor: ChatSendAnchor | null;
  readingAfterSend: boolean;
  readerAtEnd: boolean;
  userMessageKeys: () => Set<string>;
  openingLoopDelivery: () => boolean | undefined;
  inputQueueGeneration: number;
  showAutoSkillReceipt: (entry: Pick<InputEntry, 'autoSkills'>) => void;
  adoptAcceptedOpening: (entry: InputEntry) => Promise<boolean>;
}

type Runtime = ChatComposerDeliveryRuntime;

// Owns composer delivery and its renderer-side outbox handoff.
export function createChatComposerDelivery(runtime: Runtime) {
  async function sendComposer(delivery?: 'finish', plan?: string[], planObjective?: string, controlAction = false): Promise<boolean | void> {
    const input = $<HTMLTextAreaElement>('chatInput');
    const key = runtime.draftKey();
    const projectId = runtime.selectedId ? runtime.sessions.find(row => row.id === runtime.selectedId)?.projectId ?? null : runtime.selectedProjectId;
    const images = runtime.imageDrafts.get(key) ?? [];
    const text = plan?.[0] ?? (runtime.authoredComposerText().trim() || (images.length ? 'Please look at the attached files.' : ''));
    if ($<HTMLButtonElement>('chatSend').disabled) return;
    if (!text) {
      if (!controlAction) return;
      const target = runtime.selectedId, selection = runtime.selectionGeneration;
      const sameSelection = () => runtime.selectedId === target && runtime.selectionGeneration === selection;
      await runtime.refreshSessionControls();
      if (!sameSelection()) return;
      if (target && runtime.controlledSessionId === target && runtime.controlledSelection === selection && runtime.controlledTurnId) {
        await runtime.stopCurrentTurn(); return;
      }
      const pending = runtime.pendingComposerInput();
      if (pending && ['queued', 'browser'].includes(pending.state)) {
        const wasStarting = runtime.startingInputs.has(pending.id);
        if (wasStarting) runtime.cancelledStarts.add(pending.id);
        const cancelled = await run(runtime.api.cancelInput(pending.id));
        if (cancelled) {
          runtime.startingInputs.delete(pending.id);
          runtime.pendingComposerInputs = runtime.pendingComposerInputs.filter(row => row.id !== pending.id);
          runtime.dismissInputNotice(pending.id);
          runtime.paintDeliveryControls();
        } else {
          runtime.cancelledStarts.delete(pending.id);
          if (sameSelection()) { await runtime.refreshSessionControls(); if (sameSelection()) await runtime.stopCurrentTurn(); }
        }
        void runtime.refreshInputQueue();
      }
      return;
    }
    const modelSettings = { model: null, reasoningEffort: null };
    const sessionId = runtime.selectedId;
    const generation = runtime.selectionGeneration;
    const chosenMode = delivery ?? $<HTMLSelectElement>('sendMode').value;
    const mode = chosenMode === 'tool' ? 'auto' : chosenMode === 'after-turn' && runtime.controlledSessionId === runtime.selectedId && runtime.controlledSelection === runtime.selectionGeneration && runtime.controlledQueueAtFinish ? 'finish' : chosenMode;
    const dueAt = Date.now();
    const id = crypto.randomUUID();
    const authoredDraft = runtime.authoredComposerText();
    const attachmentPayload = { images: images.filter((file): file is InputImage => 'dataUrl' in file), attachments: images.filter((file): file is InputAttachment => 'id' in file),
      ...(chosenMode === 'tool' && !plan ? { delivery: 'tool' as const } : {}),
      ...(mode === 'auto' && !plan && runtime.selectedId && runtime.controlledSessionId === runtime.selectedId && runtime.controlledSelection === generation &&
        runtime.controlledCanInject && images.some(file => 'id' in file) && injectableAttachments(images) ? { attachmentDelivery: 'tool' as const } : {}) };
    const objective = plan ? planObjective : mode === 'finish' ? undefined : $<HTMLTextAreaElement>('sessionObjective').value.trim() || undefined;
    const authoredSource = plan ? 'objective' as const : 'text' as const;
    runtime.startingInputs.set(id, { id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn',
      dueAt, ...modelSettings, state: 'queued', owner: null, createdAt: dueAt, conversationId: null });
    runtime.replaceComposerDraft();
    input.value = ''; runtime.inputDrafts.delete(key);
    runtime.restoreSkills();
    runtime.imageDrafts.delete(key); runtime.paintComposerImages();
    if (sessionId === null) {
      runtime.pendingNewInput = { id, generation };
      markUnboundOpening();
    } else if (!runtime.sessions.find(row => row.id === sessionId)?.conversationId) {
      noteOpeningSession(sessionId);
    }
    if (mode !== 'finish' && runtime.followOutput()) { runtime.sendAnchor = null; runtime.readingAfterSend = false; runtime.readerAtEnd = true; }
    else if (mode !== 'finish') { runtime.sendAnchor = { key: `input:${id}`, inputId: id, before: runtime.userMessageKeys(), session: runtime.selectedId, seen: false, smoothUntil: 0 }; runtime.readingAfterSend = false; }
    void runtime.refreshInputQueue();
    runtime.paintDeliveryControls();
    try {
      const currentWebProvider = sessionId === null && isWebProviderId($<HTMLSelectElement>('webProvider').value)
        ? $<HTMLSelectElement>('webProvider').value as WebProviderId
        : undefined;
      const result = await run(runtime.api.sendInput({ id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, automation: mode === 'finish' ? undefined : $<HTMLSelectElement>('chatAutomation').value as InputAutomation, loopAfterTurn: runtime.openingLoopDelivery(), mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn', dueAt, webProvider: currentWebProvider, ...modelSettings }));
      if (runtime.cancelledStarts.has(id)) return;
      if (!result) {
        const retained = (await run(runtime.api.listInputs()))?.find(row => row.id === id);
        if (retained) {
          runtime.pendingComposerInputs = [...runtime.pendingComposerInputs.filter(row => row.id !== id), retained];
          runtime.showAutoSkillReceipt(retained);
          await runtime.adoptAcceptedOpening(retained);
          return true;
        }
        if (runtime.selectedId === sessionId && runtime.selectionGeneration === generation && !runtime.authoredComposerText()) {
          runtime.inputDrafts.set(key, authoredDraft); input.value = authoredDraft; runtime.restoreSkills();
        }
        else if (!runtime.inputDrafts.get(key)) runtime.inputDrafts.set(key, authoredDraft);
        if (images.length) runtime.imageDrafts.set(key, [...images, ...(runtime.imageDrafts.get(key) ?? [])]);
        if (runtime.draftKey() === key) runtime.paintComposerImages();
        if (runtime.pendingNewInput?.id === id) runtime.pendingNewInput = null;
        return;
      }
      runtime.inputQueueGeneration++;
      runtime.pendingComposerInputs = [...runtime.pendingComposerInputs.filter(row => row.id !== result.id), result];
      runtime.showAutoSkillReceipt(result);
      if (sessionId === null && runtime.selectionGeneration === generation && runtime.pendingNewInput?.id === id && result.automation &&
          ($<HTMLSelectElement>('chatAutomation').value !== result.automation || runtime.openingLoopDelivery() !== result.loopAfterTurn))
        await run(runtime.api.setInputAutomation(result.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, runtime.openingLoopDelivery()));
      if (sessionId === null && runtime.selectionGeneration === generation) {
        runtime.pendingNewInput = { id: result.id, generation };
        await runtime.adoptAcceptedOpening(result);
      }
      $('composerStatus').textContent = '';
      void runtime.refreshInputQueue();
      return true;
    } finally { runtime.cancelledStarts.delete(id); runtime.startingInputs.delete(id); runtime.paintDeliveryControls(); void runtime.refreshInputQueue(); }
  }

  return { sendComposer };
}
