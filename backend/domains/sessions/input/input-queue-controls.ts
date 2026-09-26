import { queuedFollowup } from '../../../../contracts/input.js';
import { conversationWasSuperseded, getSession } from '../history/store.js';
import { z } from 'zod';
import { inputArgs, type InputArgs, type InputEntry } from './input-schema.js';

type AutomationHooks = {
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string, loopAfterTurn?: boolean) => Promise<void>;
};

type Runtime = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<InputEntry[]>;
  commit(next: InputEntry[]): Promise<void>;
  materializeOpening(entry: InputEntry): Promise<void>;
  automationHooks(): AutomationHooks | null;
  rejectBrowserDecision(id: string, error: Error): void;
  removeWithdrawnOpening(id: string): Promise<void>;
};

export function createInputQueueControls(runtime: Runtime) {
  async function cancelInput(id: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const selected = current.find(entry => entry.id === id);
      const found = selected && (current.find(root => root.companionInputId === selected.id) ?? selected);
      if (!found || !['queued', 'browser', 'failed', 'cancelled'].includes(found.state)) return false;
      await runtime.commit(current.map(entry => entry.id === found.id || entry.id === found.companionInputId ? { ...entry, state: 'cancelled', cancelledByUser: true,
        error: found.state === 'browser' ? found.requiresAuthorization && found.sendAuthorizedAt === undefined
          ? 'Not sent: this delivery was cancelled before Send was authorized.'
          : 'Cancelled locally. Delivery to the provider is unconfirmed; the message may already have been sent.'
          : found.state === 'queued' ? undefined : entry.error } : entry));
      runtime.rejectBrowserDecision(id, new Error('goal_browser_cancelled'));
      await runtime.removeWithdrawnOpening(found.id);
      return true;
    });
  }

  async function reorderQueuedInputs(sessionId: string, ids: string[]): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const queue = current.filter(row => row.sessionId === sessionId && queuedFollowup(row) && !row.recovery && row.state === 'queued');
      if (!ids.length || ids.length !== queue.length || new Set(ids).size !== ids.length || queue.some(row => !ids.includes(row.id))) return false;
      const positions = new Map(ids.map((id, index) => [id, index]));
      const ticket = queue.find(row => row.silenceBoundary)?.silenceBoundary;
      await runtime.commit(current.map(row => positions.has(row.id) ? { ...row, queueOrder: positions.get(row.id)!,
        ...(ticket ? { silenceBoundary: row.id === ids[0] ? ticket : undefined } : {}) } : row));
      return true;
    });
  }

  async function cancelFinishInputs(periodicOnly: boolean): Promise<void> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const next = current.map(row => row.finishOwner && (!periodicOnly || row.finishOwner.periodic) && !['sent', 'cancelled', 'failed'].includes(row.state)
        ? { ...row, state: 'cancelled' as const, error: 'Automatic follow-up cancelled by settings. Already offered input may have reached the provider.' } : row);
      if (next.some((row, index) => row !== current[index])) await runtime.commit(next);
    });
  }

  async function editQueuedInput(id: string, text: string, afterTurn?: boolean): Promise<boolean> {
    return runtime.serial(async () => {
      const value = inputArgs.shape.text.parse(text);
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id && entry.state === 'queued' && queuedFollowup(entry) && !entry.recovery);
      if (!row) return false;
      if (current.filter(entry => !['sent', 'cancelled', 'failed'].includes(entry.state)).reduce((sum, entry) => sum + Buffer.byteLength(entry === row ? value : entry.text), 0) > 1024000)
        throw new Error('Queued messages exceed the text limit');
      await runtime.commit(current.map(entry => entry === row ? { ...row, text: value, authoredSource: 'text',
        ...(afterTurn === undefined ? {} : { afterTurn }), deliveryText: undefined, autoSkills: undefined } : entry));
      return true;
    });
  }

  async function setInputAutomation(id: string, automation: NonNullable<InputArgs['automation']>, loopAfterTurn?: boolean): Promise<boolean> {
    return runtime.serial(async () => {
      const mode = z.enum(['off', 'goal', 'loop']).parse(automation);
      const delivery = z.boolean().optional().parse(loopAfterTurn);
      const current = await runtime.load();
      const entry = current.find(row => row.id === id && row.purpose !== 'decision' && ['queued', 'browser', 'sent', 'tool'].includes(row.state));
      if (!entry) return false;
      const conversationId = entry.conversationId;
      if (conversationId && await conversationWasSuperseded(conversationId)) return false;
      const sessionId = entry.sessionId ?? entry.deliveredSessionId;
      if (sessionId && (await getSession(sessionId))?.conversationId !== conversationId) return false;
      await runtime.commit(current.map(row => row === entry ? { ...row, automation: mode,
        ...(delivery === undefined ? {} : { loopAfterTurn: delivery }) } : row));
      if (conversationId && (mode === 'off' || entry.state !== 'queued')) {
        const hooks = runtime.automationHooks();
        if (!hooks) throw new Error('Input delivery is not ready');
        await hooks.applyAutomation(conversationId, mode, entry.state === 'sent' ? 'after-send' : 'before-send', undefined, delivery);
      }
      return true;
    });
  }

  async function noteInputStartupError(id: string, error: string | null): Promise<InputEntry | null> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id);
      if (!row) return null;
      if (row.state !== 'queued') return { ...row };
      try { await runtime.materializeOpening(row); }
      catch (failure) { error = 'Local chat setup failed: ' + (failure as Error).message; }
      const released = !error && !!row.error?.startsWith('Message queued. ');
      const next = { ...row, error: error ? error.slice(0, 200) : undefined, ...(released ? { dueAt: Math.max(row.dueAt, Date.now()) } : {}) };
      await runtime.commit(current.map(entry => entry === row ? next : entry));
      return { ...next };
    });
  }

  return { cancelInput, reorderQueuedInputs, cancelFinishInputs, editQueuedInput, setInputAutomation, noteInputStartupError };
}
