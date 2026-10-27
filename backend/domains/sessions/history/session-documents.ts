import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentPlanSchema, agentPlanUpdateSchema, MAX_AGENT_PLAN_BYTES, type AgentPlan, type AgentPlanUpdate } from '../../../../contracts/agent-plan.js';
import type { SessionSummary } from '../../../../contracts/session.js';

type DocumentEntry = {
  summary: Pick<SessionSummary, 'conversationId' | 'retiredChatAt' | 'chatIds'>;
};

export type ProjectPlanState = { request: string; plan: string; updatedAt: number };
const MAX_PROJECT_PLAN_STATE_BYTES = 196_608;

type SessionDocumentsRuntime<Entry extends DocumentEntry> = {
  assertSessionId(id: string): void;
  ensureOpen(id: string): Promise<Entry>;
  enqueueSessionOperation<T>(entry: Entry, label: string, operation: () => Promise<T>): Promise<T>;
  sessionDirectory(id: string): string;
  waitForSessionQueue(id: string): Promise<void>;
};

export function createSessionDocuments<Entry extends DocumentEntry>(runtime: SessionDocumentsRuntime<Entry>) {
  async function readPlanFile(id: string): Promise<AgentPlan | null> {
    let handle;
    try {
      handle = await fs.open(path.join(runtime.sessionDirectory(id), 'plan.json'), 'r');
      const buffer = Buffer.alloc(MAX_AGENT_PLAN_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_AGENT_PLAN_BYTES) return null;
      const parsed = agentPlanSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function readSessionPlan(id: string): Promise<AgentPlan | null> {
    runtime.assertSessionId(id);
    await runtime.waitForSessionQueue(id);
    return readPlanFile(id);
  }

  async function updateSessionPlan(
    id: string,
    conversationId: string,
    input: AgentPlanUpdate,
    startedAt: number,
    recovery?: { storedAt: number }
  ): Promise<boolean> {
    const plan = agentPlanSchema.parse({ ...agentPlanUpdateSchema.parse(input), updatedAt: startedAt });
    const bytes = JSON.stringify(plan);
    if (Buffer.byteLength(bytes) > MAX_AGENT_PLAN_BYTES) throw new Error('Plan exceeds its storage budget');
    const entry = await runtime.ensureOpen(id);
    return runtime.enqueueSessionOperation(entry, 'plan', async () => {
      // The session queue prevents a stale conversation from overwriting its successor's plan.
      if (entry.summary.conversationId !== conversationId) {
        const retiredAt = entry.summary.retiredChatAt?.[conversationId];
        if (!recovery || !entry.summary.conversationId || !entry.summary.chatIds.includes(conversationId) ||
          typeof retiredAt !== 'number' || !Number.isFinite(recovery.storedAt) || recovery.storedAt < 0 ||
          Math.max(startedAt, recovery.storedAt) >= retiredAt) return false;
      }
      const previous = await readPlanFile(id);
      if (previous && previous.updatedAt > startedAt) return false;
      const target = path.join(runtime.sessionDirectory(id), 'plan.json');
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, 'utf8');
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return true;
    });
  }

  async function readProjectPlanFile(id: string): Promise<ProjectPlanState | null> {
    let handle;
    try {
      handle = await fs.open(path.join(runtime.sessionDirectory(id), 'project-plan.json'), 'r');
      const buffer = Buffer.alloc(MAX_PROJECT_PLAN_STATE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PROJECT_PLAN_STATE_BYTES) return null;
      const value = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as Partial<ProjectPlanState>;
      if (typeof value.request !== 'string' || typeof value.plan !== 'string' ||
          typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
      return { request: value.request, plan: value.plan, updatedAt: value.updatedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async function readProjectPlanState(id: string): Promise<ProjectPlanState | null> {
    runtime.assertSessionId(id);
    await runtime.waitForSessionQueue(id);
    return readProjectPlanFile(id);
  }

  async function updateProjectPlanState(
    id: string,
    conversationId: string,
    input: Omit<ProjectPlanState, 'updatedAt'>,
    updatedAt: number
  ): Promise<boolean> {
    if (input.request.length > 72_000 || input.plan.length > 24_000 || !Number.isFinite(updatedAt)) {
      throw new Error('Project plan exceeds its storage budget');
    }
    const state = { ...input, updatedAt };
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes, 'utf8') > MAX_PROJECT_PLAN_STATE_BYTES) throw new Error('Project plan exceeds its storage budget');
    const entry = await runtime.ensureOpen(id);
    return runtime.enqueueSessionOperation(entry, 'project plan', async () => {
      if (entry.summary.conversationId !== conversationId) return false;
      const target = path.join(runtime.sessionDirectory(id), 'project-plan.json');
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, 'utf8');
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return true;
    });
  }

  async function clearProjectPlanState(id: string, conversationId: string): Promise<boolean> {
    const entry = await runtime.ensureOpen(id);
    return runtime.enqueueSessionOperation(entry, 'clear project plan', async () => {
      if (entry.summary.conversationId !== conversationId) return false;
      await fs.rm(path.join(runtime.sessionDirectory(id), 'project-plan.json'), { force: true });
      return true;
    });
  }

  return {
    readSessionPlan,
    updateSessionPlan,
    readProjectPlanState,
    updateProjectPlanState,
    clearProjectPlanState,
  };
}
