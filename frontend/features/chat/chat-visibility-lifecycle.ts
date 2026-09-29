import type { SwarmState } from '../../../contracts/session.js';

interface ChatVisibilityLifecycleRuntime {
  loadSessions: () => Promise<void>;
  loadSwarm: () => Promise<SwarmState | null>;
  paintSwarm: (state: SwarmState) => void;
  stopToolActivityExpiry: () => void;
  clearDurationTimer: () => void;
}

export function createChatVisibilityLifecycle(runtime: ChatVisibilityLifecycleRuntime) {
  let visible = false;

  async function refreshAll(): Promise<void> {
    await runtime.loadSessions();
    const swarm = await runtime.loadSwarm();
    if (swarm) runtime.paintSwarm(swarm);
  }

  function setVisible(next: boolean): void {
    if (visible === next) return;
    visible = next;
    if (next) void refreshAll();
    else {
      runtime.stopToolActivityExpiry();
      runtime.clearDurationTimer();
    }
  }

  function setVisibleState(next: boolean): void {
    visible = next;
  }

  return {
    get visible() { return visible; },
    setVisible,
    setVisibleState,
    refreshAll
  };
}
