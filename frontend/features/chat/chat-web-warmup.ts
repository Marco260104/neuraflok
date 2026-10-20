import { usesApiProvider } from '../../../contracts/chat-protocol.js';
import { isWebProviderId, type WebProviderId } from '../../../contracts/web-providers.js';
import type { AppState } from '../../../contracts/types.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { run } from '../../shared/dom.js';
import { adoptOpeningSession, markUnboundOpening, releaseOpeningSession } from './chat-composer-ready.js';

export const WEB_CHAT_WARMUP_TEXT = 'NEURAFLOK_WARMUP';

export function isWarmupInput(entry: { warmup?: boolean }): boolean {
  return entry.warmup === true;
}

export function webChatWarmupNeeded(_input: {
  apiExecutor: boolean;
  signedIn: boolean;
  newChatSelected: boolean;
  selectedId: string | null;
  pending: boolean;
  warmupInFlight: boolean;
}): boolean {
  return false;
}

export interface WebChatWarmupRuntime {
  api: Pick<typeof window.api, 'sendInput' | 'listInputs'>;
  state: () => AppState | null;
  newChatSelected: boolean;
  selectedId: string | null;
  selectedProjectId: string | null;
  selectionGeneration: number;
  pendingNewInput: { id: string; generation: number } | null;
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  adoptAcceptedOpening: (entry: InputEntry) => Promise<boolean>;
  selectSession: (id: string) => void;
  paintDeliveryControls: () => void;
  refreshInputQueue: () => Promise<void>;
  setPendingNewInput: (value: { id: string; generation: number } | null) => void;
}

export function createWebChatWarmup(runtime: WebChatWarmupRuntime): { ensure: () => void } {
  let inflightGeneration: number | null = null;

  async function bindWarmupSession(entry: InputEntry, generation: number): Promise<void> {
    const adopted = await runtime.adoptAcceptedOpening(entry);
    const boundId = entry.sessionId ?? entry.deliveredSessionId ?? entry.id;
    if (!adopted && boundId && runtime.selectionGeneration === generation && runtime.newChatSelected && runtime.selectedId === null) {
      adoptOpeningSession(boundId);
      runtime.selectSession(boundId);
    }
  }

  async function start(): Promise<void> {
    const generation = runtime.selectionGeneration;
    const id = crypto.randomUUID();
    const dueAt = Date.now();
    const projectId = runtime.selectedProjectId;
    const seed: InputEntry = {
      id, sessionId: null, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
      mode: 'auto', dueAt, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: dueAt,
      conversationId: null
    };
    runtime.startingInputs.set(id, seed);
    runtime.setPendingNewInput({ id, generation });
    markUnboundOpening();
    runtime.paintDeliveryControls();
    try {
      const picker = document.getElementById('webProvider') as HTMLSelectElement | null;
      const currentWebProvider = picker && isWebProviderId(picker.value) ? picker.value as WebProviderId : undefined;
      const result = await run(runtime.api.sendInput({
        id, sessionId: null, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
        mode: 'auto', dueAt, model: null, reasoningEffort: null, webProvider: currentWebProvider
      }));
      if (runtime.selectionGeneration !== generation) return;
      if (!result) {
        const retained = (await run(runtime.api.listInputs()))?.find(row => row.id === id);
        if (retained) {
          runtime.pendingComposerInputs = [...runtime.pendingComposerInputs.filter(row => row.id !== id), retained];
          await bindWarmupSession(retained, generation);
        } else if (runtime.pendingNewInput?.id === id) {
          runtime.setPendingNewInput(null);
          releaseOpeningSession(null);
        }
        return;
      }
      runtime.pendingComposerInputs = [...runtime.pendingComposerInputs.filter(row => row.id !== result.id), result];
      runtime.setPendingNewInput({ id: result.id, generation });
      await bindWarmupSession(result, generation);
    } finally {
      runtime.startingInputs.delete(id);
      if (inflightGeneration === generation) inflightGeneration = null;
      runtime.paintDeliveryControls();
      void runtime.refreshInputQueue();
    }
  }

  function ensure(): void {
    const app = runtime.state();
    if (!app) return;
    const provider = isWebProviderId(app.config.ui.webProvider) ? app.config.ui.webProvider : 'deepseek';
    const warmupInFlight = inflightGeneration === runtime.selectionGeneration ||
      [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].some(isWarmupInput);
    if (!webChatWarmupNeeded({
      apiExecutor: usesApiProvider(app.config.ui.chatExecutor),
      signedIn: app.bridge.webProviders?.[provider]?.signedIn === true,
      newChatSelected: runtime.newChatSelected,
      selectedId: runtime.selectedId,
      pending: runtime.pendingNewInput !== null,
      warmupInFlight
    })) return;
    inflightGeneration = runtime.selectionGeneration;
    markUnboundOpening();
    runtime.paintDeliveryControls();
    void start();
  }

  return { ensure };
}
