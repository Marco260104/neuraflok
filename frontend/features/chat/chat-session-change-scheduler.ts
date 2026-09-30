import type { SessionChange } from '../../../contracts/session.js';

export interface ChangedTranscriptState {
  all: boolean;
  ids: Set<string>;
}

export interface ChatSessionChangeScheduler {
  scheduleReload: (change?: SessionChange) => void;
  changedTranscripts: ChangedTranscriptState;
}

interface ChatSessionChangeSchedulerRuntime {
  isVisible: () => boolean;
  loadSessions: (detail: 'changed') => Promise<void>;
}

// Coalesces session-change pushes while retaining every transcript owner until the refresh consumes them.
export function createChatSessionChangeScheduler(runtime: ChatSessionChangeSchedulerRuntime): ChatSessionChangeScheduler {
  let timer: number | undefined;
  let refreshDirty = false;
  let changedTranscripts: ChangedTranscriptState = { all: false, ids: new Set() };

  function scheduleReload(change?: SessionChange): void {
    if (!runtime.isVisible()) return;
    if (change?.allTranscripts) changedTranscripts.all = true;
    for (const id of change?.sessionIds ?? []) changedTranscripts.ids.add(id);
    // Keep one refresh in flight because repeated reads can invalidate every result on a slower store.
    if (timer !== undefined) { refreshDirty = true; return; }
    timer = window.setTimeout(() => {
      refreshDirty = false;
      void runtime.loadSessions('changed').finally(() => {
        timer = undefined;
        if (refreshDirty) scheduleReload();
      });
    }, 400);
  }

  return {
    scheduleReload,
    get changedTranscripts() { return changedTranscripts; },
    set changedTranscripts(value: ChangedTranscriptState) { changedTranscripts = value; }
  };
}
