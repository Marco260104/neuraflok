import type { Handoff, SessionEvent, SessionSummary, TokenPressure } from '../../../contracts/session.js';

export interface ChatSessionRemovalState {
  sessions: SessionSummary[];
  pressure: Map<string, TokenPressure>;
  sessionTotal: number;
  selectedId: string | null;
  events: SessionEvent[];
  totalEvents: number;
  detailFor: string | null;
  detailCursor: number | null;
  handoff: Handoff | null;
  handoffFor: string | null;
  detailLoadGeneration: number;
  handoffLoadGeneration: number;
}

export function createChatSessionRemoval(state: ChatSessionRemovalState) {
  return function removeFromView(id: string): void {
    state.sessions = state.sessions.filter(entry => entry.id !== id);
    state.pressure.delete(id);
    state.sessionTotal = Math.max(0, state.sessionTotal - 1);
    if (state.selectedId !== id) return;
    state.selectedId = null;
    state.events = [];
    state.totalEvents = 0;
    state.detailFor = null;
    state.detailCursor = null;
    state.handoff = null;
    state.handoffFor = null;
    state.detailLoadGeneration++;
    state.handoffLoadGeneration++;
  };
}
