export interface ChatSessionActionsRuntime {
  $: typeof import('../../shared/dom.js').$;
  api: Pick<typeof window.api, 'deleteSession' | 'setSessionBlocked' | 'setSessionTrusted'>;
  loadSessions: () => Promise<void>;
  paintSessions: () => void;
  removeFromView: (id: string) => void;
  run: typeof import('../../shared/dom.js').run;
  save: () => Promise<void>;
  setBlockedChats: (value: Set<string>) => void;
  setTrustedChats: (value: Set<string>) => void;
  toast: typeof import('../../shared/dom.js').toast;
  t: typeof import('../../shared/i18n.js').t;
}

type Runtime = ChatSessionActionsRuntime;

export function createChatSessionActions(runtime: Runtime) {
  async function toggleUnattributedBlock(blocked: boolean): Promise<void> {
    runtime.$<HTMLInputElement>('allowUnattributedCalls').checked = !blocked;
    await runtime.save();
    runtime.paintSessions();
  }

  async function toggleSessionBlock(id: string, blocked: boolean): Promise<void> {
    const next = await runtime.run(runtime.api.setSessionBlocked(id, blocked));
    if (next === null) return;
    runtime.setBlockedChats(new Set(next));
    runtime.paintSessions();
  }

  async function toggleSessionTrust(id: string, expectedConversationId: string, trusted: boolean): Promise<void> {
    const next = await runtime.run(runtime.api.setSessionTrusted(id, expectedConversationId, trusted));
    if (next === null) return;
    runtime.setTrustedChats(new Set(next));
    runtime.paintSessions();
  }

  async function deleteSession(id: string): Promise<void> {
    const done = await runtime.run(runtime.api.deleteSession(id));
    if (done === null) return;
    runtime.removeFromView(id);
    runtime.toast(runtime.t('Chat removed from the app'));
    await runtime.loadSessions();
  }

  return { deleteSession, toggleSessionBlock, toggleSessionTrust, toggleUnattributedBlock };
}
