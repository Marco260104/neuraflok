import { agentPlanUpdateSchema, type AgentPlanUpdate } from '../../../../../contracts/agent-plan.js';
import { readDurable, writeDurableNow } from '../../../../persistence/durable.js';

const STATE_NAME = 'request-plans';
const STATE_VERSION = 1;
const MAX_PENDING_PLANS = 256;
const PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingRequestPlan {
  requestId: string;
  update: AgentPlanUpdate;
  startedAt: number;
  storedAt: number;
}

interface PersistedRequestPlans {
  version: number;
  entries: PendingRequestPlan[];
}

const pending = new Map<string, PendingRequestPlan>();
let loaded = false;
let queue: Promise<void> = Promise.resolve();

function serial<T>(run: () => Promise<T>): Promise<T> {
  const work = queue.then(run, run);
  queue = work.then(() => undefined, () => undefined);
  return work;
}

function validEntry(value: unknown): PendingRequestPlan | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PendingRequestPlan>;
  if (typeof item.requestId !== 'string' || item.requestId.length < 1 || item.requestId.length > 200) return null;
  if (typeof item.startedAt !== 'number' || !Number.isFinite(item.startedAt) || item.startedAt < 0) return null;
  if (typeof item.storedAt !== 'number' || !Number.isFinite(item.storedAt) || item.storedAt < 0) return null;
  const update = agentPlanUpdateSchema.safeParse(item.update);
  return update.success ? { requestId: item.requestId, update: update.data, startedAt: item.startedAt, storedAt: item.storedAt } : null;
}

function prune(now = Date.now()): void {
  for (const [requestId, entry] of pending) {
    if (entry.storedAt < now - PLAN_TTL_MS) pending.delete(requestId);
  }
  while (pending.size > MAX_PENDING_PLANS) pending.delete(pending.keys().next().value!);
}

async function load(): Promise<void> {
  if (loaded) return;
  const saved = await readDurable<PersistedRequestPlans>(STATE_NAME);
  if (saved?.version === STATE_VERSION && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_PENDING_PLANS)) {
      const entry = validEntry(raw);
      if (entry) pending.set(entry.requestId, entry);
    }
  }
  prune();
  loaded = true;
}

function cloneEntry(entry: PendingRequestPlan): PendingRequestPlan {
  return {
    ...entry,
    update: { ...entry.update, plan: entry.update.plan.map(step => ({ ...step })) }
  };
}

function snapshot(): PersistedRequestPlans {
  return { version: STATE_VERSION, entries: [...pending.values()].map(cloneEntry) };
}

async function persist(): Promise<void> {
  await writeDurableNow(STATE_NAME, pending.size ? snapshot() : null);
}

/** Saves the newest complete plan for one request-scoped model turn. */
export function savePendingRequestPlan(requestId: string, input: AgentPlanUpdate, startedAt: number): Promise<boolean> {
  const update = agentPlanUpdateSchema.parse(input);
  return serial(async () => {
    await load();
    const previous = pending.get(requestId);
    if (previous && previous.startedAt > startedAt) return false;
    const before = new Map(pending);
    pending.delete(requestId);
    pending.set(requestId, { requestId, update, startedAt, storedAt: Date.now() });
    prune();
    try {
      await persist();
    } catch (error) {
      pending.clear();
      for (const [id, entry] of before) pending.set(id, entry);
      throw error;
    }
    return true;
  });
}

/** Applies and removes one pending plan after its exact owner is known. */
export function consumePendingRequestPlan<T>(
  requestId: string,
  consume: (entry: PendingRequestPlan) => Promise<T>
): Promise<{ found: false } | { found: true; value: T }> {
  return serial(async () => {
    await load();
    const entry = pending.get(requestId);
    if (!entry) return { found: false };
    const value = await consume(cloneEntry(entry));
    pending.delete(requestId);
    try {
      await persist();
    } catch (error) {
      pending.set(requestId, entry);
      throw error;
    }
    return { found: true, value };
  });
}

/** Returns request identifiers that may have exact owners after recovery. */
export function pendingRequestPlanIds(): Promise<string[]> {
  return serial(async () => {
    await load();
    return [...pending.keys()];
  });
}

export function resetRequestPlansForTests(): void {
  pending.clear();
  loaded = false;
  queue = Promise.resolve();
}
