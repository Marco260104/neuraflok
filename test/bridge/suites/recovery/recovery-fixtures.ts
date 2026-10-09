import { providerForConversationId, WEB_PROVIDERS } from "../../../../contracts/web-providers.js";
import { CHAT_SILENCE_MS, expect, opened, recordToolCall, request, REQUEST_ID_GRACE_MS, unattributedIncidentsSettledForTests, vi } from '../../test-context.js';

export const recoveryState: { PRIME: string; WORKER: string; OTHER: string; recoveryCase: number; requests: number } = { PRIME: '', WORKER: '', OTHER: '', recoveryCase: 0, requests: 0 };

export function resetRecoveryFixture(): void {
  const suffix = String(++recoveryState.recoveryCase).padStart(12, '0');
  recoveryState.PRIME = 'abababab-1111-2222-3333-' + suffix;
  recoveryState.WORKER = 'cdcdcdcd-1111-2222-3333-' + suffix;
  recoveryState.OTHER = 'efefefef-1111-2222-3333-' + suffix;
}

export async function unattributed(requestId?: string): Promise<unknown> {
    const recorded = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/whoever.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      ...(requestId ? { requestId } : {})
    });
    await unattributedIncidentsSettledForTests();
    return recorded;
  }

export async function unattributedTurn(requestId: string): Promise<void> {
    const call = unattributed(requestId);
    await vi.advanceTimersByTimeAsync(REQUEST_ID_GRACE_MS);
    await call;
  }

export function events(conversationId: string, items: unknown[]): Promise<any> {
    return request('POST', '/events', { body: { conversationId, events: items } });
  }

export async function attributed(conversationId: string, endsActivity = false, startedAt?: number): Promise<void> {
    const requestId = `wfr_repair_${++recoveryState.requests}`;
    // This describe deliberately reuses conversation ids while fake time jumps backwards between tests. Keep default synthetic call starts monotonic; boundary tests pass their exact time.
    const callStartedAt = startedAt ?? Date.now() + recoveryState.requests * CHAT_SILENCE_MS * 4;
    await events(conversationId, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        calls: [{ messageId: `m-${recoveryState.requests}`, tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/mine.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: callStartedAt,
      requestId,
      endsActivity
    });
  }

export const openTurn = (turnId: string): unknown => ({ kind: 'turn_start', time: Date.now(), turnId });

export const endTurn = (turnId: string, outcome: string): unknown => ({
    kind: 'turn_end',
    time: Date.now(),
    turnId,
    outcome
  });

export async function maintenanceBatch(
    repaired?: string,
    repairAction?: 'reloaded' | 'reopened' | 'present'
  ): Promise<Array<{ conversationId: string; token: string; reason: string }>> {
    const path = repaired
      ? `/status?repaired=${encodeURIComponent(repaired)}${repairAction ? `&repairAction=${repairAction}` : ''}`
      : '/status';
    const reply = await request('GET', path);
    expect(reply.status).toBe(200);
    return reply.body.repairs ?? [];
  }

export async function maintenance(
    repaired?: string,
    repairAction?: 'reloaded' | 'reopened' | 'present'
  ): Promise<{ conversationId: string; token: string; reason: string } | null> {
    const batch = await maintenanceBatch(repaired, repairAction);
    expect(batch.length).toBeLessThanOrEqual(1);
    return batch[0] ?? null;
  }

export const chatOf = (repair: { conversationId: string } | null): string | null => repair?.conversationId ?? null;

export const reopened = (conversationId: string): string[] => {
    const provider = providerForConversationId(conversationId);
    if (!provider) return [];
    const target = new URL(WEB_PROVIDERS[provider].chatUrl);
    return opened.filter((url) => {
      const parsed = new URL(url);
      return parsed.origin === target.origin && parsed.pathname === target.pathname && !parsed.searchParams.has('neuraflok-command');
    });
  };

export const FRESH = 'fafafafa-1111-2222-3333-444444444444';

