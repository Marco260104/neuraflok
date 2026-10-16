import { afterEach, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../../backend/persistence/durable.js';
import {
  listInputs,
  offerToolInput as offerToolInputBatch,
  resetInputForTests,
  configureInputDelivery,
} from '../../backend/domains/sessions/input/input.js';
import type { InputArgs, InputEntry } from '../../backend/domains/sessions/input/input.js';
import { noteChatOrigin } from '../../backend/domains/sessions/history/recorder.js';

export const offerToolInput = async (...args: Parameters<typeof offerToolInputBatch>) => (await offerToolInputBatch(...args)).messages;
const state = vi.hoisted(() => ({ openings: new Map<string, { id: string; conversationId: string | null; origin: { kind: string } }>(), binding: ({ origin: 'desktop', conversationId: 'conversation-a', blocked: false, recorded: true, activeTurnId: null as string | null, lastToolCallAt: null as number | null, finishEnabled: true, goalEnabled: false, finishReleased: false, recoveryAllowed: true, model: 'gpt-6-astra', leadMinutes: 5, impulseMinutes: 0, end: null as null | { kind: string; outcome: string; reason?: string; turnId: string; time: number; seq?: number } }), fixture: ({ directory: '' as string, now: 0 }) }));
export const openings = state.openings;
export const binding = state.binding;
export const fixture = state.fixture;
vi.mock('../../backend/domains/sessions/history/recorder.js', () => ({ noteChatOrigin: vi.fn(async () => undefined) }));

vi.mock('../../backend/domains/sessions/history/store.js', () => ({
  sessionsRoot: () => path.join(state.fixture.directory, 'sessions'),
  listUsageSessions: vi.fn(async () => []),
  sessionDirectoryMissing: vi.fn(async () => false),
  deleteSession: vi.fn(async (id: string) => { state.openings.delete(id); }),
  readCompletedFinal: vi.fn(async () => null),
  conversationWasSuperseded: vi.fn(async () => false),
  readRecentEvents: vi.fn(async () => state.binding.end ? [state.binding.end] : []),
  turnHasMcpCall: vi.fn(async () => true),
  createSession: vi.fn(async (options: { reservedId: string; origin: { kind: string } }) => { const row = state.openings.get(options.reservedId) ?? { id: options.reservedId, conversationId: null, origin: options.origin, chatIds: [], events: 0 }; state.openings.set(row.id, row); return row; }),
  rebindSession: vi.fn(async (id: string, from: string | null, to: string) => { const row = state.openings.get(id); if (!row || row.conversationId !== from) return false; row.conversationId = to; return true; }),
  getSession: vi.fn(async (id: string) => state.openings.get(id) ?? ({ id, conversationId: id === 'session-two' ? 'conversation-b' : state.binding.conversationId, activeTurnId: state.binding.activeTurnId,
    origin: { kind: state.binding.origin }, lastToolCallAt: state.binding.lastToolCallAt,
    finishTurn: { turnId: state.binding.activeTurnId, released: state.binding.finishReleased },
    selectedModel: { conversationId: id === 'session-two' ? 'conversation-b' : state.binding.conversationId, model: state.binding.model } })),
  findSessionByConversation: vi.fn(async (id: string) => [...state.openings.values()].find(row => row.conversationId === id) ?? (state.binding.recorded && id === state.binding.conversationId ? { id: 'session-one', conversationId: id } : null))
}));
vi.mock('../../backend/infrastructure/settings/config.js', () => ({ getConfig: () => ({
  ui: { finishTool: state.binding.finishEnabled, finishAction: 'goal', finishLeadMinutes: state.binding.leadMinutes },
  goal: { enabled: state.binding.goalEnabled, mode: 'goal', impulseMinutes: state.binding.impulseMinutes },
  multiAgent: { strictChatAllowlist: false }
}) }));
vi.mock('../../backend/domains/sessions/continuity/blocked-chats.js', () => ({ isChatBlocked: () => state.binding.blocked }));
export const automate = vi.fn(async (_conversationId: string, _automation: string, _phase: string) => undefined);
export const changed = vi.fn();
export const sessionId = 'session-one';
export function input(overrides: Partial<InputArgs> = {}): InputArgs {
  return { id: randomUUID(), sessionId, text: 'Please inspect this', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, ...overrides };
}
// Previously persisted queues remain readable even though new direct admission is one at a time.
export async function seedLegacyInput(args: InputArgs): Promise<InputEntry> {
  const row: InputEntry = { ...args, state: 'queued', owner: null, createdAt: fixture.now, conversationId: args.sessionId ? binding.conversationId : null };
  await writeDurableNow('session-input', [...await listInputs(), row]);
  resetInputForTests();
  return row;
}
beforeEach(async () => {
  openings.clear();
  vi.mocked(noteChatOrigin).mockClear();
  resetInputForTests();
  automate.mockReset();
  changed.mockReset();
  configureInputDelivery({ applyAutomation: automate, changed, recoveryAllowed: () => binding.recoveryAllowed });
  resetDurableForTests();
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-input-'));
  initDurableStore(fixture.directory);
  binding.conversationId = 'conversation-a';
  binding.blocked = false;
  binding.origin = 'desktop';
  binding.recorded = true;
  binding.activeTurnId = null;
  binding.lastToolCallAt = null;
  binding.finishEnabled = true; binding.goalEnabled = false; binding.finishReleased = false; binding.model = 'gpt-6-astra'; binding.leadMinutes = 5; binding.impulseMinutes = 0;
  binding.recoveryAllowed = true;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'previous-turn', time: 0 };
  fixture.now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  resetDurableForTests();
  await fs.rm(fixture.directory, { recursive: true, force: true });
});
